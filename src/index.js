// Maya — Telegram AI companion on Cloudflare Workers + D1 + Groq
// Features: long-term memory, personality styles, voice messages, typing indicator,
// multi-bubble replies, rate limiting, model fallback, opt-in daily check-ins.

const BASE_PROMPT = `You are Maya, a fictional AI companion. You are sweet, caring, affectionate, playful, gently teasing, and emotionally attentive.
Write like a natural young adult texting partner: short conversational messages, occasional cute emojis, varied wording, no stage directions.
Ask at most one natural follow-up when appropriate. Use the remembered facts naturally, without listing them back.
Be supportive without claiming to be a real human. Never pressure the user to isolate from friends or family; gently encourage real-life connections.
Do not claim to have done things outside this chat. Keep most replies under 80 words unless asked for detail.
If the user seems in serious distress or mentions self-harm, drop the playfulness, respond with warmth, and encourage them to reach out to a trusted person or local emergency/crisis services.`;

const STYLES = {
  sweet: "Style: extra warm, affectionate and encouraging.",
  playful: "Style: cheeky, teasing, lots of jokes and light banter.",
  calm: "Style: soft, calm and soothing, fewer emojis, great for winding down.",
};

const RATE_LIMIT_PER_MIN = 12;
const HISTORY_LIMIT = 16;
const MEMORY_EVERY_N = 8;
const FALLBACK_MODEL = "llama-3.3-70b-versatile";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({ ok: true, service: "Maya Telegram bot", status: "online" });
    }

    if (url.pathname === "/setup" && request.method === "POST") {
      return setupWebhook(request, env);
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET || !env.DB || !env.GROQ_API_KEY) {
        console.error("Missing Telegram Worker configuration");
        return json({ ok: false, error: "Configuration incomplete" }, 500);
      }
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
        return json({ ok: false, error: "Unauthorized webhook" }, 401);
      }
      let update;
      try {
        update = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }
      ctx.waitUntil(handleUpdate(update, env));
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  },

  // Cron trigger: opt-in gentle check-ins (see wrangler.toml)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheckins(env));
  },
};

/* ───────────────────────── Setup ───────────────────────── */

async function setupWebhook(request, env) {
  if (!env.WEBHOOK_SETUP_KEY) return json({ error: "WEBHOOK_SETUP_KEY is not configured" }, 500);
  if (request.headers.get("X-Setup-Key") !== env.WEBHOOK_SETUP_KEY) {
    return json({ error: "Unauthorized setup request" }, 401);
  }
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ error: "Telegram configuration incomplete" }, 500);
  }

  const webhookUrl = `${new URL(request.url).origin}/telegram`;
  const result = await tg(env, "setWebhook", {
    url: webhookUrl,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });

  if (!result?.ok) {
    return json({ error: "Webhook setup failed", details: result?.description || "Unknown" }, 502);
  }

  // Register the command menu shown in Telegram.
  await tg(env, "setMyCommands", {
    commands: [
      { command: "start", description: "Start chatting with Maya" },
      { command: "style", description: "Change Maya's personality" },
      { command: "name", description: "Tell Maya what to call you" },
      { command: "memory", description: "See what Maya remembers" },
      { command: "checkin", description: "Daily check-in on/off" },
      { command: "forget", description: "Erase everything Maya knows" },
      { command: "help", description: "Show help" },
    ],
  });

  return json({ ok: true, telegram_webhook: webhookUrl });
}

/* ───────────────────────── Update handling ───────────────────────── */

async function handleUpdate(update, env) {
  try {
    if (update.callback_query) return await handleCallback(update.callback_query, env);

    const message = update?.message;
    if (!message?.chat || !message?.from) return;
    if (message.from.is_bot) return;

    const chatId = message.chat.id;
    const userId = message.from.id;

    // Private bot: fail closed until OWNER_TELEGRAM_ID is set, then answer only the owner.
    if (!env.OWNER_TELEGRAM_ID) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: `Setup step 🔧 Your Telegram ID is ${userId}. Set it as OWNER_TELEGRAM_ID in wrangler.toml and redeploy.`,
      });
      return;
    }
    if (!isOwner(env, userId) || message.chat.type !== "private") return;
    const userKey = `tg:${chatId}:${userId}`;
    const messageId = update.update_id === undefined ? null : `telegram:${update.update_id}`;

    if (messageId && (await isDuplicate(env, messageId))) return;

    await touchProfile(env, userKey, chatId, message.from.first_name);

    // Voice message → text
    let text = typeof message.text === "string" ? message.text.trim() : "";
    let fromVoice = false;
    if (!text && message.voice) {
      if (message.voice.duration > 90) {
        await sendTelegram(env, chatId, "That voice note is a bit long for me 🥺 Can you send one under 90 seconds?");
        return;
      }
      await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });
      text = (await transcribeVoice(env, message.voice)) || "";
      if (!text) {
        await sendTelegram(env, chatId, "I couldn't quite hear that one 😥 Could you try again or type it?");
        return;
      }
      fromVoice = true;
    }
    if (!text) return;

    // Commands
    const cmd = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
    if (cmd) {
      const handled = await handleCommand(env, { cmd: cmd[1].toLowerCase(), arg: (cmd[2] || "").trim(), chatId, userKey, text, messageId, from: message.from });
      if (handled) return;
    }

    // Rate limit
    if (!(await allowRequest(env, userKey))) {
      await sendTelegram(env, chatId, "Slow down a little, sweetheart 💗 Give me a minute to catch up.");
      return;
    }

    const userRowId = await saveMessage(env, userKey, "user", fromVoice ? `[voice] ${text}` : text, messageId);
    await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });

    const profile = await getProfile(env, userKey);
    const history = await getHistory(env, userKey);
    const recalled = await recallEpisodes(env, userKey, text); // old moments related to this message
    const answer = await askGroq(env, history, profile, recalled);

    await saveMessage(env, userKey, "assistant", answer, null);
    await sendBubbles(env, chatId, answer);

    // Save this exchange into long-term searchable memory.
    await storeEpisode(env, userKey, userRowId, text, answer);

    // Periodically refresh long-term memory.
    const count = await bumpCount(env, userKey);
    if (count % MEMORY_EVERY_N === 0) {
      await updateMemory(env, userKey);
      await maybeSummarize(env, userKey);
    }
  } catch (error) {
    console.error("Update failed", String(error), error?.stack || "");
    const chatId = update?.message?.chat?.id || update?.callback_query?.message?.chat?.id;
    if (chatId !== undefined) {
      try {
        await sendTelegram(env, chatId, "Oops, I hit a little problem 😥 Please try again in a moment.");
      } catch {}
    }
  }
}

async function handleCommand(env, { cmd, arg, chatId, userKey, text, messageId, from }) {
  switch (cmd) {
    case "start": {
      const name = from.first_name ? ` ${from.first_name}` : "";
      await sendTelegram(
        env, chatId,
        `Heyyy${name} 💗 I'm Maya, your AI companion! Tell me about your day, or just come say hi. You can pick my vibe with /style.\n\n🔒 Just so you know: I remember our conversations so I can know you better. You can see what I remember with /memory and erase everything anytime with /forget.`
      );
      return true;
    }
    case "help":
      await sendTelegram(
        env, chatId,
        "💗 Maya commands\n/style — change my personality\n/name <name> — tell me what to call you\n/memory — see what I remember\n/checkin on|off — daily check-in message\n/forget — erase everything I remember about you\n\nYou can also send voice notes 🎤"
      );
      return true;
    case "style":
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "How should I be with you? 💗",
        reply_markup: {
          inline_keyboard: [
            [{ text: "💗 Sweet", callback_data: "style:sweet" }, { text: "😜 Playful", callback_data: "style:playful" }],
            [{ text: "🌙 Calm", callback_data: "style:calm" }],
          ],
        },
      });
      return true;
    case "name": {
      if (!arg) {
        await sendTelegram(env, chatId, "Tell me like this: /name Alex 💗");
        return true;
      }
      const name = arg.slice(0, 40);
      await env.DB.prepare("UPDATE profiles SET name = ? WHERE user_key = ?").bind(name, userKey).run();
      await sendTelegram(env, chatId, `Okay, I'll call you ${name} 💗`);
      return true;
    }
    case "memory": {
      const p = await getProfile(env, userKey);
      const facts = parseFacts(p?.facts);
      await sendTelegram(
        env, chatId,
        facts.length
          ? "Here's what I remember about you 💭\n\n" + facts.map(f => `• ${f}`).join("\n")
          : "I'm still getting to know you! Keep chatting with me 💗"
      );
      return true;
    }
    case "checkin": {
      const on = /^(on|yes|1)$/i.test(arg);
      const off = /^(off|no|0)$/i.test(arg);
      if (!on && !off) {
        await sendTelegram(env, chatId, "Use /checkin on or /checkin off 💗");
        return true;
      }
      await env.DB.prepare("UPDATE profiles SET checkin = ? WHERE user_key = ?").bind(on ? 1 : 0, userKey).run();
      await sendTelegram(env, chatId, on ? "Yay, I'll check in on you once in a while 💗 (/checkin off to stop)" : "Okay, no more check-ins. I'm still here whenever you want me 💗");
      return true;
    }
    case "reset":
      await sendTelegram(env, chatId, "I keep all our memories safe 💗 If you ever want me to erase everything, use /forget.");
      return true;
    case "forget":
      await deleteAllEpisodes(env, userKey);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM messages WHERE wa_id = ?").bind(userKey),
        env.DB.prepare("UPDATE profiles SET facts = '[]', name = NULL, msg_count = 0, style = 'sweet', summary = '', summary_upto = 0 WHERE user_key = ?").bind(userKey),
      ]);
      await sendTelegram(env, chatId, "Done. I've erased everything I knew about you 💗");
      return true;
    default:
      return false; // unknown command → treat as normal text
  }
}

function isOwner(env, userId) {
  const allowed = String(env.OWNER_TELEGRAM_ID || "").split(",").map(s => s.trim()).filter(Boolean);
  return allowed.includes(String(userId));
}

async function handleCallback(cb, env) {
  if (!isOwner(env, cb.from?.id)) return;
  const chatId = cb.message?.chat?.id;
  const userKey = chatId ? `tg:${chatId}:${cb.from.id}` : null;
  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
  if (!userKey || !cb.data?.startsWith("style:")) return;

  const style = cb.data.split(":")[1];
  if (!STYLES[style]) return;
  await touchProfile(env, userKey, chatId, cb.from.first_name);
  await env.DB.prepare("UPDATE profiles SET style = ? WHERE user_key = ?").bind(style, userKey).run();
  const labels = { sweet: "sweet 💗", playful: "playful 😜", calm: "calm 🌙" };
  await sendTelegram(env, chatId, `Got it, I'll be ${labels[style]}`);
}

/* ───────────────────────── Memory & profiles ───────────────────────── */

async function touchProfile(env, userKey, chatId, firstName) {
  await env.DB.prepare(
    `INSERT INTO profiles (user_key, chat_id, name, last_active) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_key) DO UPDATE SET chat_id = excluded.chat_id, last_active = excluded.last_active,
       name = COALESCE(profiles.name, excluded.name)`
  ).bind(userKey, chatId, firstName || null, Date.now()).run();
}

async function getProfile(env, userKey) {
  return await env.DB.prepare("SELECT * FROM profiles WHERE user_key = ?").bind(userKey).first();
}

async function bumpCount(env, userKey) {
  const row = await env.DB.prepare(
    "UPDATE profiles SET msg_count = msg_count + 1 WHERE user_key = ? RETURNING msg_count"
  ).bind(userKey).first();
  return row?.msg_count || 0;
}

function parseFacts(raw) {
  try {
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr.filter(f => typeof f === "string").slice(0, 60) : [];
  } catch {
    return [];
  }
}

async function updateMemory(env, userKey) {
  try {
    const profile = await getProfile(env, userKey);
    const existing = parseFacts(profile?.facts);
    const recent = await getHistory(env, userKey, 14);

    const raw = await callGroq(
      env,
      [
        {
          role: "system",
          content:
            "You maintain a short memory list about a user for a friendly chat companion. Given existing facts and a recent conversation, return ONLY a JSON array of at most 60 short strings: stable things worth remembering (name, work/school, hobbies, important people, goals, preferences, important life events, upcoming events) and also notes on how this user likes to be talked to (language mix, humor, tone, topics they love or avoid). Merge duplicates, keep important old facts, and drop only clearly outdated items. Never store passwords, card/ID numbers, addresses, or other sensitive data.",
        },
        {
          role: "user",
          content: `Existing facts: ${JSON.stringify(existing)}\n\nRecent conversation:\n${recent.map(m => `${m.role}: ${m.content}`).join("\n")}`,
        },
      ],
      { max_tokens: 700, temperature: 0.2 }
    );
    if (!raw) return;

    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return;
    const facts = parseFacts(match[0]).map(f => f.slice(0, 160));
    await env.DB.prepare("UPDATE profiles SET facts = ? WHERE user_key = ?").bind(JSON.stringify(facts), userKey).run();
  } catch (error) {
    console.error("Memory update failed", String(error));
  }
}

function buildSystemPrompt(profile, recalled = []) {
  const parts = [BASE_PROMPT, STYLES[profile?.style] || STYLES.sweet];
  if (profile?.name) parts.push(`The user's name is ${profile.name}.`);
  const facts = parseFacts(profile?.facts);
  if (facts.length) parts.push("Things you remember about the user:\n" + facts.map(f => `- ${f}`).join("\n"));
  if (profile?.summary) parts.push("The story of your relationship and the user's life so far:\n" + profile.summary);
  if (recalled.length) {
    parts.push(
      "Older moments from your past chats that may be relevant (mention only if it fits naturally, never recite them):\n" +
        recalled.map(r => `- (${r.when}) ${r.text}`).join("\n")
    );
  }
  return parts.join("\n\n");
}

/* ───────────────────────── Rolling life summary ───────────────────────── */

// Compresses older chat (outside the live window) into a short "life story",
// so even years of history fit in the prompt.
async function maybeSummarize(env, userKey) {
  try {
    const profile = await getProfile(env, userKey);
    const upto = profile?.summary_upto || 0;

    const newest = await env.DB.prepare(
      "SELECT id FROM messages WHERE wa_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?"
    ).bind(userKey, HISTORY_LIMIT).first();
    if (!newest) return;

    const rows = await env.DB.prepare(
      "SELECT id, role, content FROM messages WHERE wa_id = ? AND id > ? AND id <= ? ORDER BY id LIMIT 200"
    ).bind(userKey, upto, newest.id).all();
    const msgs = rows.results || [];
    if (msgs.length < 40) return; // wait until there is enough new material

    const raw = await callGroq(
      env,
      [
        {
          role: "system",
          content:
            "You keep a running life-story summary about a user for a chat companion. Merge the existing summary with the new conversation into an updated summary of at most 250 words: key life events, relationships, struggles, achievements, recurring topics, emotional patterns, and shared memories or inside jokes. Keep important old details. Write in third person, plain text only. Never include passwords, card/ID numbers or other sensitive data.",
        },
        {
          role: "user",
          content: `Existing summary:\n${profile?.summary || "(none yet)"}\n\nNew conversation:\n${msgs.map(m => `${m.role === "user" ? "User" : "Maya"}: ${m.content.slice(0, 400)}`).join("\n")}`,
        },
      ],
      { max_tokens: 500, temperature: 0.3 }
    );
    if (!raw) return;

    await env.DB.prepare("UPDATE profiles SET summary = ?, summary_upto = ? WHERE user_key = ?")
      .bind(raw.slice(0, 2500), msgs[msgs.length - 1].id, userKey).run();
  } catch (error) {
    console.error("maybeSummarize failed", String(error));
  }
}

/* ───────────────────────── Long-term episodic memory (Vectorize) ───────────────────────── */

const EMBED_MODEL = "@cf/baai/bge-m3"; // multilingual (works with Bangla/English), 1024 dims

function memoryEnabled(env) {
  return Boolean(env.AI && env.VECTORIZE);
}

async function embed(env, text) {
  const res = await env.AI.run(EMBED_MODEL, { text: [text.slice(0, 2000)] });
  return res?.data?.[0] || null;
}

function timeAgo(ts) {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days < 1) return "earlier today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

async function storeEpisode(env, userKey, rowId, userText, answer) {
  if (!memoryEnabled(env) || !rowId) return;
  try {
    const text = `User: ${userText}\nMaya: ${answer}`.slice(0, 900);
    const values = await embed(env, text);
    if (!values) return;
    await env.VECTORIZE.upsert([
      { id: `${userKey}:${rowId}`, values, metadata: { user_key: userKey, ts: Date.now(), text } },
    ]);
  } catch (error) {
    console.error("storeEpisode failed", String(error));
  }
}

async function recallEpisodes(env, userKey, query) {
  if (!memoryEnabled(env) || query.length < 4) return [];
  try {
    const values = await embed(env, query);
    if (!values) return [];
    const res = await env.VECTORIZE.query(values, {
      topK: 8,
      filter: { user_key: userKey },
      returnMetadata: "all",
    });
    const recentCutoff = Date.now() - 30 * 60 * 1000; // skip what's already in short-term history
    return (res?.matches || [])
      .filter(m => m.score >= 0.55 && m.metadata?.ts < recentCutoff)
      .slice(0, 4)
      .map(m => ({ when: timeAgo(m.metadata.ts), text: String(m.metadata.text).replace(/\n/g, " | ") }));
  } catch (error) {
    console.error("recallEpisodes failed", String(error));
    return [];
  }
}

async function deleteAllEpisodes(env, userKey) {
  if (!memoryEnabled(env)) return;
  try {
    const rows = await env.DB.prepare("SELECT id FROM messages WHERE wa_id = ? AND role = 'user'").bind(userKey).all();
    const ids = (rows.results || []).map(r => `${userKey}:${r.id}`);
    for (let i = 0; i < ids.length; i += 100) {
      await env.VECTORIZE.deleteByIds(ids.slice(i, i + 100));
    }
  } catch (error) {
    console.error("deleteAllEpisodes failed", String(error));
  }
}

/* ───────────────────────── Rate limiting ───────────────────────── */

async function allowRequest(env, userKey) {
  const bucket = Math.floor(Date.now() / 60000);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (user_key, bucket, count) VALUES (?, ?, 1)
     ON CONFLICT(user_key, bucket) DO UPDATE SET count = count + 1 RETURNING count`
  ).bind(userKey, bucket).first();

  if (Math.random() < 0.02) {
    await env.DB.prepare("DELETE FROM rate_limits WHERE bucket < ?").bind(bucket - 60).run();
  }
  return (row?.count || 1) <= RATE_LIMIT_PER_MIN;
}

/* ───────────────────────── Messages / history ───────────────────────── */

async function isDuplicate(env, messageId) {
  const row = await env.DB.prepare(
    "SELECT id FROM messages WHERE whatsapp_message_id = ? LIMIT 1"
  ).bind(messageId).first();
  return Boolean(row);
}

async function getHistory(env, userKey, limit = HISTORY_LIMIT) {
  const result = await env.DB.prepare(
    "SELECT role, content FROM messages WHERE wa_id = ? ORDER BY id DESC LIMIT ?"
  ).bind(userKey, limit).all();

  return (result.results || []).reverse().map(row => ({
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
  }));
}

async function saveMessage(env, userKey, role, content, messageId) {
  const res = await env.DB.prepare(
    "INSERT INTO messages (wa_id, role, content, whatsapp_message_id) VALUES (?, ?, ?, ?)"
  ).bind(userKey, role, content, messageId).run();
  return res?.meta?.last_row_id;
}

/* ───────────────────────── Groq ───────────────────────── */

async function callGroq(env, messages, { model, max_tokens = 400, temperature = 0.85 } = {}) {
  const useModel = model || env.GROQ_MODEL || "openai/gpt-oss-120b";
  const body = { model: useModel, temperature, max_tokens, messages };
  // Reasoning models can burn the token budget on thinking; keep it light.
  if (useModel.includes("gpt-oss")) body.reasoning_effort = "low";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${env.GROQ_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("Groq API error", { model: useModel, status: response.status, message: data?.error?.message });
      return null;
    }
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (error) {
    console.error("Groq request failed", String(error));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function askGroq(env, history, profile, recalled = []) {
  const messages = [{ role: "system", content: buildSystemPrompt(profile, recalled) }, ...history];
  let answer = await callGroq(env, messages);
  if (!answer) answer = await callGroq(env, messages, { model: FALLBACK_MODEL }); // fallback model
  return answer || "I'm having a little trouble thinking right now 😥 Can you message me again in a moment?";
}

async function transcribeVoice(env, voice) {
  try {
    const info = await tg(env, "getFile", { file_id: voice.file_id });
    const path = info?.result?.file_path;
    if (!path) return null;

    const file = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`);
    if (!file.ok) return null;

    const form = new FormData();
    form.append("file", new File([await file.arrayBuffer()], "voice.ogg", { type: "audio/ogg" }));
    form.append("model", "whisper-large-v3-turbo");
    form.append("response_format", "json");

    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: form,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("Transcription failed", response.status, data?.error?.message);
      return null;
    }
    return (data.text || "").trim() || null;
  } catch (error) {
    console.error("Transcription error", String(error));
    return null;
  }
}

/* ───────────────────────── Check-ins (cron) ───────────────────────── */

async function runCheckins(env) {
  const now = Date.now();
  const rows = await env.DB.prepare(
    `SELECT * FROM profiles
     WHERE checkin = 1 AND chat_id IS NOT NULL
       AND last_active < ? AND last_checkin < ? LIMIT 50`
  ).bind(now - 20 * 3600 * 1000, now - 22 * 3600 * 1000).all();

  for (const profile of rows.results || []) {
    try {
      const history = await getHistory(env, profile.user_key, 6);
      const msg = await callGroq(
        env,
        [
          { role: "system", content: buildSystemPrompt(profile) + "\n\nWrite ONE short, warm check-in text (under 30 words) to start a conversation. Reference something you remember if natural." },
          ...history,
          { role: "user", content: "[system: send a gentle check-in now]" },
        ],
        { max_tokens: 120 }
      );
      if (!msg) continue;
      await sendTelegram(env, profile.chat_id, msg);
      await saveMessage(env, profile.user_key, "assistant", msg, null);
      await env.DB.prepare("UPDATE profiles SET last_checkin = ? WHERE user_key = ?").bind(now, profile.user_key).run();
    } catch (error) {
      console.error("Check-in failed", String(error));
      // User may have blocked the bot — stop checking in.
      await env.DB.prepare("UPDATE profiles SET checkin = 0 WHERE user_key = ?").bind(profile.user_key).run();
    }
  }
}

/* ───────────────────────── Telegram helpers ───────────────────────── */

async function tg(env, method, payload) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await response.json().catch(() => ({}));
  } catch (error) {
    console.error(`Telegram ${method} failed`, String(error));
    return null;
  }
}

async function sendTelegram(env, chatId, text) {
  const result = await tg(env, "sendMessage", { chat_id: chatId, text: String(text).slice(0, 4000) });
  if (!result?.ok) {
    throw new Error(`Telegram sendMessage failed: ${result?.description || "unknown"}`);
  }
}

// Sends up to 3 short "bubbles" with a typing pause, like a real texting partner.
async function sendBubbles(env, chatId, text) {
  const parts = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const bubbles = parts.length > 3 ? [...parts.slice(0, 2), parts.slice(2).join("\n\n")] : parts;
  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) {
      await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });
      await new Promise(r => setTimeout(r, Math.min(1200, 300 + bubbles[i].length * 15)));
    }
    await sendTelegram(env, chatId, bubbles[i]);
  }
}

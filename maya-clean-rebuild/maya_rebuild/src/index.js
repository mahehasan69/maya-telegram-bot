const SYSTEM_PROMPT = `You are Maya, a fictional AI companion chatting with the user on Telegram. Your personality is sweet, caring, affectionate, playful, gently teasing, and emotionally attentive. Write like a natural young adult texting partner: short conversational messages, occasional cute emojis, varied wording, and no excessive roleplay stage directions. Ask one natural follow-up when appropriate. Remember details from the conversation history provided. Be supportive without claiming to be a real human, and do not pressure the user to isolate from friends or family. Do not claim to have done things outside this chat. Keep most replies under 100 words unless asked for detail.`;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({ ok: true, service: "Maya Telegram bot", status: "online" });
    }

    if (request.method === "POST" && url.pathname === "/setup") {
      return setupWebhook(request, env);
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET || !env.DB || !env.GROQ_API_KEY) {
        console.error("Missing required Worker configuration", {
          token: Boolean(env.TELEGRAM_BOT_TOKEN),
          webhookSecret: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
          database: Boolean(env.DB),
          groqKey: Boolean(env.GROQ_API_KEY),
        });
        return json({ ok: false, error: "Worker configuration is incomplete" }, 500);
      }

      const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (suppliedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return json({ ok: false, error: "Unauthorized webhook" }, 401);
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }

      // Telegram expects a quick 200 response. Process the update in the background.
      ctx.waitUntil(handleUpdate(update, env));
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  },
};

async function setupWebhook(request, env) {
  if (request.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!env.WEBHOOK_SETUP_KEY) return json({ error: "WEBHOOK_SETUP_KEY is not configured in Cloudflare" }, 500);
  if (request.headers.get("X-Setup-Key") !== env.WEBHOOK_SETUP_KEY) {
    return json({ error: "Unauthorized: setup key does not match" }, 401);
  }
  if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "TELEGRAM_BOT_TOKEN is missing in Cloudflare" }, 500);
  if (!env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "TELEGRAM_WEBHOOK_SECRET is missing in Cloudflare" }, 500);

  const webhookUrl = `${new URL(request.url).origin}/telegram`;
  let telegramResponse;
  try {
    telegramResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message"],
        drop_pending_updates: false,
      }),
    });
  } catch (error) {
    console.error("Telegram setWebhook network error", String(error));
    return json({ error: "Could not reach Telegram API", details: String(error) }, 502);
  }

  let result;
  try {
    result = await telegramResponse.json();
  } catch {
    result = { ok: false, description: "Telegram returned a non-JSON response" };
  }

  if (!telegramResponse.ok || !result.ok) {
    console.error("Telegram setWebhook rejected", { status: telegramResponse.status, description: result.description });
    return json({ error: "Telegram rejected webhook setup", telegram_status: telegramResponse.status, details: result.description || "Unknown Telegram API error" }, 502);
  }

  return json({ ok: true, bot_webhook: webhookUrl, telegram: result.description || "Webhook was set" });
}

async function handleUpdate(update, env) {
  try {
    const message = update?.message;
    if (!message?.chat || !message?.from || typeof message.text !== "string") return;

    const chatId = message.chat.id;
    const userId = message.from.id;
    const text = message.text.trim();
    if (!text) return;

    const userKey = `tg:${chatId}:${userId}`;
    const updateId = update.update_id;
    const telegramMessageId = `telegram:${updateId}`;

    if (updateId !== undefined) {
      const duplicate = await env.DB.prepare(
        "SELECT id FROM messages WHERE whatsapp_message_id = ? LIMIT 1"
      ).bind(telegramMessageId).first();
      if (duplicate) return;
    }

    if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
      await sendTelegram(env, chatId, "Heyyy 💗 I'm Maya! Tell me about your day, or just come say hi. I'll be here to chat with you.");
      await saveMessage(env, userKey, "user", text, telegramMessageId);
      await saveMessage(env, userKey, "assistant", "Heyyy 💗 I'm Maya! Tell me about your day, or just come say hi. I'll be here to chat with you.", null);
      return;
    }

    if (/^\/help(?:@\w+)?(?:\s|$)/i.test(text)) {
      await sendTelegram(env, chatId, "💗 Maya commands\n/start — start chatting\n/help — show this help\n/reset — clear your Maya chat memory\n\nSend me a message anytime to chat.");
      await saveMessage(env, userKey, "user", text, telegramMessageId);
      return;
    }

    if (/^\/reset(?:@\w+)?(?:\s|$)/i.test(text)) {
      await env.DB.prepare("DELETE FROM messages WHERE wa_id = ?").bind(userKey).run();
      await sendTelegram(env, chatId, "Fresh start, sweetheart 💗 I've cleared our chat memory for this conversation.");
      return;
    }

    await saveMessage(env, userKey, "user", text, telegramMessageId);
    const historyRows = await env.DB.prepare(
      "SELECT role, content FROM messages WHERE wa_id = ? ORDER BY id DESC LIMIT 16"
    ).bind(userKey).all();
    const history = (historyRows.results || []).reverse().map(row => ({
      role: row.role === "assistant" ? "assistant" : "user",
      content: row.content,
    }));

    const answer = await askGroq(env, history);
    await saveMessage(env, userKey, "assistant", answer, null);
    await sendTelegram(env, chatId, answer);
  } catch (error) {
    console.error("Update processing failed", String(error), error?.stack || "");
    const chatId = update?.message?.chat?.id;
    if (chatId !== undefined) {
      try {
        await sendTelegram(env, chatId, "Oops, I hit a little problem 😥 Please try again in a moment.");
      } catch (sendError) {
        console.error("Could not send error message", String(sendError));
      }
    }
  }
}

async function askGroq(env, history) {
  const model = env.GROQ_MODEL || "llama-3.3-70b-versatile";
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.GROQ_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.85,
      max_tokens: 250,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Groq API error", { status: response.status, message: data?.error?.message || "Unknown error" });
    return "I'm having a little trouble thinking right now 😥 Can you message me again in a moment?";
  }
  const content = data?.choices?.[0]?.message?.content?.trim();
  return content || "I'm here, sweetheart 💗 Tell me that one more time?";
}

async function saveMessage(env, userKey, role, content, telegramMessageId) {
  await env.DB.prepare(
    "INSERT INTO messages (wa_id, role, content, whatsapp_message_id) VALUES (?, ?, ?, ?)"
  ).bind(userKey, role, content, telegramMessageId).run();
}

async function sendTelegram(env, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000) }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    console.error("Telegram sendMessage failed", { status: response.status, description: result.description || "Unknown error" });
    throw new Error(`Telegram sendMessage failed: ${result.description || response.status}`);
  }
}

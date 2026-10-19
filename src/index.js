
const SYSTEM_PROMPT = `You are Maya, a fictional AI companion. Your personality is sweet, caring, affectionate, playful, gently teasing, and emotionally attentive. Write like a natural young adult texting partner: short conversational messages, occasional cute emojis, varied wording, and no excessive roleplay stage directions. Ask one natural follow-up when appropriate. Remember details from the conversation history provided. Be supportive without claiming to be a real human, and do not pressure the user to isolate from friends or family. Do not claim to have done things outside this chat. Keep most replies under 100 words unless asked for detail.`;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "Maya Telegram + WhatsApp bot",
        status: "online",
      });
    }

    if (url.pathname === "/setup" && request.method === "POST") {
      return setupWebhook(request, env);
    }

    // Meta webhook verification handshake.
    if (url.pathname === "/whatsapp" && request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (
        mode === "subscribe" &&
        token &&
        token === env.WHATSAPP_VERIFY_TOKEN &&
        challenge
      ) {
        return new Response(challenge, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      return new Response("Webhook verification failed", { status: 403 });
    }

    // WhatsApp incoming messages.
    if (url.pathname === "/whatsapp" && request.method === "POST") {
      if (
        !env.WHATSAPP_APP_SECRET ||
        !env.WHATSAPP_ACCESS_TOKEN ||
        !env.WHATSAPP_PHONE_NUMBER_ID ||
        !env.WHATSAPP_VERIFY_TOKEN ||
        !env.DB ||
        !env.GROQ_API_KEY
      ) {
        console.error("Missing WhatsApp Worker configuration");
        return json({ ok: false, error: "WhatsApp configuration incomplete" }, 500);
      }

      // Verify Meta's signature against the exact raw request body.
      const rawBody = await request.text();
      const signature = request.headers.get("X-Hub-Signature-256");

      const validSignature = await verifyMetaSignature(
        rawBody,
        signature,
        env.WHATSAPP_APP_SECRET
      );

      if (!validSignature) {
        return json({ ok: false, error: "Invalid Meta signature" }, 401);
      }

      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }

      // Acknowledge quickly; process messages in the background.
      ctx.waitUntil(handleWhatsAppUpdate(payload, env));
      return json({ ok: true });
    }

    // Existing Telegram webhook.
    if (request.method === "POST" && url.pathname === "/telegram") {
      if (
        !env.TELEGRAM_BOT_TOKEN ||
        !env.TELEGRAM_WEBHOOK_SECRET ||
        !env.DB ||
        !env.GROQ_API_KEY
      ) {
        console.error("Missing Telegram Worker configuration");
        return json({ ok: false, error: "Telegram configuration incomplete" }, 500);
      }

      if (
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
        env.TELEGRAM_WEBHOOK_SECRET
      ) {
        return json({ ok: false, error: "Unauthorized webhook" }, 401);
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }

      ctx.waitUntil(handleTelegramUpdate(update, env));
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  },
};

async function verifyMetaSignature(body, signature, appSecret) {
  if (!signature || !signature.startsWith("sha256=")) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(appSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const digest = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body)
    );

    const expected = "sha256=" + Array.from(new Uint8Array(digest))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");

    if (signature.length !== expected.length) return false;

    // Compare all characters rather than stopping at the first mismatch.
    let difference = 0;
    for (let i = 0; i < expected.length; i++) {
      difference |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return difference === 0;
  } catch (error) {
    console.error("Meta signature verification failed", String(error));
    return false;
  }
}

async function setupWebhook(request, env) {
  if (!env.WEBHOOK_SETUP_KEY) {
    return json({ error: "WEBHOOK_SETUP_KEY is not configured" }, 500);
  }

  if (request.headers.get("X-Setup-Key") !== env.WEBHOOK_SETUP_KEY) {
    return json({ error: "Unauthorized setup request" }, 401);
  }

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ error: "Telegram configuration incomplete" }, 500);
  }

  const webhookUrl = `${new URL(request.url).origin}/telegram`;

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message"],
        drop_pending_updates: false,
      }),
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.ok) {
    console.error("Telegram setWebhook rejected", {
      status: response.status,
      description: result.description,
    });
    return json({
      error: "Telegram webhook setup failed",
      details: result.description || "Unknown Telegram API error",
    }, 502);
  }

  return json({
    ok: true,
    telegram_webhook: webhookUrl,
    telegram: result.description || "Webhook was set",
  });
}

async function handleTelegramUpdate(update, env) {
  try {
    const message = update?.message;
    if (!message?.chat || !message?.from || typeof message.text !== "string") return;

    const chatId = message.chat.id;
    const userId = message.from.id;
    const text = message.text.trim();
    if (!text) return;

    const userKey = `tg:${chatId}:${userId}`;
    const messageId = update.update_id === undefined
      ? null
      : `telegram:${update.update_id}`;

    if (messageId && await isDuplicate(env, messageId)) return;

    if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
      const answer = "Heyyy 💗 I'm Maya! Tell me about your day, or just come say hi. I'll be here to chat with you.";
      await sendTelegram(env, chatId, answer);
      await saveMessage(env, userKey, "user", text, messageId);
      await saveMessage(env, userKey, "assistant", answer, null);
      return;
    }

    if (/^\/help(?:@\w+)?(?:\s|$)/i.test(text)) {
      await saveMessage(env, userKey, "user", text, messageId);
      await sendTelegram(
        env,
        chatId,
        "💗 Maya commands\n/start — start chatting\n/help — show this help\n/reset — clear your Maya chat memory\n\nSend me a message anytime to chat."
      );
      return;
    }

    if (/^\/reset(?:@\w+)?(?:\s|$)/i.test(text)) {
      await env.DB.prepare("DELETE FROM messages WHERE wa_id = ?")
        .bind(userKey).run();
      await sendTelegram(env, chatId, "Fresh start, sweetheart 💗 I've cleared our chat memory for this conversation.");
      return;
    }

    await saveMessage(env, userKey, "user", text, messageId);
    const history = await getHistory(env, userKey);
    const answer = await askGroq(env, history);
    await saveMessage(env, userKey, "assistant", answer, null);
    await sendTelegram(env, chatId, answer);
  } catch (error) {
    console.error("Telegram update failed", String(error), error?.stack || "");
    const chatId = update?.message?.chat?.id;
    if (chatId !== undefined) {
      try {
        await sendTelegram(env, chatId, "Oops, I hit a little problem 😥 Please try again in a moment.");
      } catch (sendError) {
        console.error("Telegram error reply failed", String(sendError));
      }
    }
  }
}

async function handleWhatsAppUpdate(payload, env) {
  try {
    if (payload?.object !== "whatsapp_business_account") return;

    const entries = payload.entry || [];

    for (const entry of entries) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;

        const value = change.value || {};
        for (const message of value.messages || []) {
          // This version handles ordinary text messages.
          if (message.type !== "text" || !message.from || !message.id) continue;

          if (await isDuplicate(env, `whatsapp:${message.id}`)) continue;

          const sender = message.from;
          const text = message.text?.body?.trim();
          if (!text) continue;

          // Separate identity prevents Telegram and WhatsApp histories mixing.
          const userKey = `wa:${sender}`;
          let answer;

          if (/^\/start\b/i.test(text) || /^hi maya$/i.test(text)) {
            answer = "Heyyy 💗 I'm Maya! Tell me about your day, or just come say hi. I'll be here to chat with you.";
            await saveMessage(env, userKey, "user", text, `whatsapp:${message.id}`);
            await saveMessage(env, userKey, "assistant", answer, null);
          } else if (/^\/help\b/i.test(text)) {
            answer = "💗 I'm Maya! Send me a message anytime to chat. Send /reset if you'd like me to clear our chat memory.";
            await saveMessage(env, userKey, "user", text, `whatsapp:${message.id}`);
          } else if (/^\/reset\b/i.test(text)) {
            await env.DB.prepare("DELETE FROM messages WHERE wa_id = ?")
              .bind(userKey).run();
            answer = "Fresh start, sweetheart 💗 I've cleared our chat memory for this conversation.";
          } else {
            await saveMessage(env, userKey, "user", text, `whatsapp:${message.id}`);
            const history = await getHistory(env, userKey);
            answer = await askGroq(env, history);
            await saveMessage(env, userKey, "assistant", answer, null);
          }

          await sendWhatsApp(env, sender, answer);
        }
      }
    }
  } catch (error) {
    console.error("WhatsApp update failed", String(error), error?.stack || "");
  }
}

async function isDuplicate(env, messageId) {
  const row = await env.DB.prepare(
    "SELECT id FROM messages WHERE whatsapp_message_id = ? LIMIT 1"
  ).bind(messageId).first();

  return Boolean(row);
}

async function getHistory(env, userKey) {
  const result = await env.DB.prepare(
    "SELECT role, content FROM messages WHERE wa_id = ? ORDER BY id DESC LIMIT 16"
  ).bind(userKey).all();

  return (result.results || []).reverse().map(row => ({
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
  }));
}

async function askGroq(env, history) {
  const model = env.GROQ_MODEL || "openai/gpt-oss-120b";

  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GROQ_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.85,
        max_tokens: 250,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
      }),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("Groq API error", {
      status: response.status,
      message: data?.error?.message || "Unknown error",
    });
    return "I'm having a little trouble thinking right now 😥 Can you message me again in a moment?";
  }

  return data?.choices?.[0]?.message?.content?.trim()
    || "I'm here, sweetheart 💗 Tell me that one more time?";
}

async function saveMessage(env, userKey, role, content, messageId) {
  await env.DB.prepare(
    "INSERT INTO messages (wa_id, role, content, whatsapp_message_id) VALUES (?, ?, ?, ?)"
  ).bind(userKey, role, content, messageId).run();
}

async function sendTelegram(env, chatId, text) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, 4000),
      }),
    }
  );

  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    console.error("Telegram sendMessage failed", {
      status: response.status,
      description: result.description || "Unknown error",
    });
    throw new Error(`Telegram sendMessage failed: ${result.description || response.status}`);
  }
}

async function sendWhatsApp(env, recipient, text) {
  const version = env.WHATSAPP_API_VERSION || "v25.0";
  const endpoint =
    `https://graph.facebook.com/${version}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "text",
      text: { preview_url: false, body: String(text).slice(0, 4000) },
    }),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("WhatsApp send failed", {
      status: response.status,
      error: result?.error?.message || "Unknown WhatsApp API error",
      code: result?.error?.code,
    });
    throw new Error(`WhatsApp send failed with HTTP ${response.status}`);
  }
}

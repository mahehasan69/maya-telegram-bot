# Maya Telegram Bot (Cloudflare Workers)

A Telegram AI companion using Cloudflare Workers, D1, and Groq. The Worker name and D1 binding are kept compatible with the existing deployment/database.

## Cloudflare secrets required

Set these in Worker Settings → Variables and Secrets (Production):

- `TELEGRAM_BOT_TOKEN` — current token from BotFather
- `TELEGRAM_WEBHOOK_SECRET` — 1–256 chars, letters/numbers/underscore/hyphen only
- `WEBHOOK_SETUP_KEY` — a separate random setup password
- `GROQ_API_KEY` — existing Groq API key

`GROQ_MODEL` is configured in `wrangler.toml` and defaults to `llama-3.3-70b-versatile`.

## Setup webhook

After deploying, send a POST request to `https://kokoro-whatsapp.mahehassan69.workers.dev/setup` with header `X-Setup-Key` set to the exact `WEBHOOK_SETUP_KEY`. The response will return Telegram's exact error if setup fails. The webhook endpoint is `/telegram` and validates Telegram's `X-Telegram-Bot-Api-Secret-Token` header.

## Database

Uses the existing `DB` binding and existing `messages` table. Telegram keys use `tg:<chatId>:<userId>` so Telegram history stays separate from legacy WhatsApp rows. `/reset` deletes only the current Telegram conversation's history.

## Commands

- `/start`
- `/help`
- `/reset`
- Any normal text message for a conversation

## GitHub Actions

The workflow deploys on pushes to `main`. Repository Actions secrets required:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Never commit tokens or secrets.

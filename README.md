# Codex Limit Telegram Bot

A Cloudflare Worker that watches configured X/Twitter accounts, classifies each new authored tweet, and sends a Telegram alert.

The private v1 is cron-driven and outbound-only. Public subscription mode adds defensive Telegram webhook handling, D1 subscriptions, Cloudflare Queue fanout, and Durable Object rate limiting.

## Local Setup

### Isolated local test environment

Requires Node.js 22.16+ (Node 24 LTS recommended). Start the local web lab:

```sh
rtk npm install
rtk npm run lab
```

Open [the local lab](http://localhost:8790). This is separate from `dashboard:dev`:
it runs the existing monitor with local tweets, a disk-backed KV adapter, and a
local notification inbox. It never fetches X tweets or sends Telegram messages.

- Add tweets with an author, publication date, optional quoted text, and reply flag.
  The monitored authors are `sama` and `thsottiaux`; other authors are ignored.
- Run analysis manually, or start/pause the server timer (5–86400 seconds).
  Each interval starts after the previous run finishes; runs never overlap.
  Within a run, up to three tweets are classified concurrently. Each successful
  decision is saved immediately; a failed tweet does not block the rest.
  Closing the browser does not stop the timer. Stopping the server does.
- Offline mode uses the existing heuristic classifier, explicitly labeled as a
  simulation. It requires no credentials or network. Its verdicts can differ from AI.
- OpenRouter mode calls the actual project classifier and shows model/token usage.
  To enable it, copy `.env.lab.example` to `.env.lab`, set `OPENROUTER_API_KEY`,
  restart the server, and choose OpenRouter in the UI. The selected model is editable.
  Only this mode sends tweet text to OpenRouter. Provider fallback/error behavior
  uses the production classifier, with a 120-second deadline per tweet (including
  retries and response body). Provider errors pause the timer and are shown explicitly;
  heuristic fallback is not saved as a real-model result. Progress remains visible
  during manual runs.
  The lab defaults to `nvidia/nemotron-3-super-120b-a12b:free`, disables reasoning,
  and limits output to 512 tokens for short classification responses.
- The first pass seeds history without alerts. Add another fresh reset tweet after
  seeding to test a notification. Posts outside the 24-hour window do not alert.
- State and settings survive restarts in `.local-lab/data.json`. Reset clears the
  local timeline, decisions, inbox, and settings, and pauses the timer.
  Limits: 500 tweets/decisions and the last 100 run records.

The server binds to `127.0.0.1:8790`. `LAB_PORT` and `LAB_DATA_DIR` can override
the port and storage path. `.env.lab` and `.local-lab/` are ignored by Git.
Production `.dev.vars` and Cloudflare bindings are not loaded by this command.
Restart `lab` after changing TypeScript; HTML/CSS/JS changes need a browser refresh.

Verification:

```sh
rtk npm run typecheck
rtk npm test
```

### Worker development

```sh
npm install
cp .dev.vars.example .dev.vars
npm run check
npm run dev
```

Fill `.dev.vars` for local development. Never commit `.dev.vars`.

## Required Accounts And Keys

### Cloudflare

Create or use an existing Cloudflare account, then authenticate Wrangler:

```sh
npx wrangler login
npx wrangler whoami
```

### OpenRouter

Create an OpenRouter key:

1. Go to `https://openrouter.ai/settings/keys`.
2. Create an API key.
3. Use it as `OPENROUTER_API_KEY`.

The default model is `nvidia/nemotron-3-super-120b-a12b:free`. OpenRouter free model availability can change, so check `https://openrouter.ai/models?max_price=0` and update `OPENROUTER_MODEL` in `wrangler.toml` if needed.

### Telegram

Create a bot token:

1. Open Telegram and message `@BotFather`.
2. Send `/newbot`.
3. Follow the prompts.
4. Use the returned token as `TELEGRAM_BOT_TOKEN`.

Get a private chat ID:

1. Start a chat with your new bot and send any message, such as `/start`.
2. Run:

```sh
export TELEGRAM_BOT_TOKEN="<token-from-botfather>"
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"
```

3. Find `message.chat.id` in the JSON response and use it as `TELEGRAM_CHAT_IDS`.

For a group chat, add the bot to the group, send a message in the group, then run the same `getUpdates` command. Group chat IDs are usually negative numbers.

### Tweet Provider

The app uses authenticated `rettiwt-api` as its only tweet source. The scheduled monitor fetches every configured account through Rettiwt and fails the poll if any account cannot be fetched, preventing silent monitoring gaps.

Rettiwt authentication is required:

- Set `RETTIWT_API_KEY` before running the monitor.
- The key is a base64 encoding of Twitter/X cookies, so treat it as a sensitive secret.

### Cron Secret

Generate a secret for authenticated manual runs:

```sh
openssl rand -hex 32
```

Use the generated value as `CRON_SECRET`.

## Configuration

Required for private v1:

- `OPENROUTER_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_IDS`
- `RETTIWT_API_KEY`
- `CRON_SECRET`

`rettiwt-api` requires Cloudflare `nodejs_compat`, which is enabled in the Wrangler configuration.

Optional:

- `OPENROUTER_MODEL`, defaults to `nvidia/nemotron-3-super-120b-a12b:free`
- `OPENROUTER_SITE_URL`, optional attribution URL for OpenRouter rankings/analytics
- `OPENROUTER_APP_NAME`, optional attribution title, defaults to `Codex Limit Telegram Bot`
- `TARGET_USERNAME`, legacy single-account setting, defaults to `thsottiaux`
- `TARGET_USERNAMES`, optional comma-separated monitored accounts. Production defaults to `thsottiaux,sama`.
- `POLL_LOOKBACK_HOURS`, defaults to `24`
- `RECENT_DECISION_LIMIT`, defaults to `50`

Production defaults for non-secret values live in `[vars]` in `wrangler.toml`.

## Commands

```sh
npm run typecheck
npm test
npm run check
npm run dev
npm run deploy
```

## Private Deployment

Run checks before deploying:

```sh
npm install
npm run check
```

Create KV namespaces:

```sh
npx wrangler kv namespace create MONITOR_STATE
npx wrangler kv namespace create MONITOR_STATE --preview
```

Update `wrangler.toml` with the printed production `id` and preview `preview_id` values:

```toml
[[kv_namespaces]]
binding = "MONITOR_STATE"
id = "<production-kv-namespace-id>"
preview_id = "<preview-kv-namespace-id>"
```

Set required secrets:

```sh
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_IDS
npx wrangler secret put RETTIWT_API_KEY
npx wrangler secret put CRON_SECRET
```

Run a bundle dry-run:

```sh
npx wrangler deploy --dry-run --outdir /tmp/codex-limit-telegram-bot-dist
```

Deploy:

```sh
npm run deploy
```

Verify health. Replace `<worker-url>` with the URL printed by Wrangler:

```sh
curl "https://<worker-url>/health"
```

Open the local-only dashboard against the production Cloudflare KV namespace:

```sh
## Stop any existing `npm run dev` process first, then run:
npm run dashboard:dev
open "http://localhost:8787/dashboard"
```

`dashboard:dev` uses `wrangler.dashboard.toml`, which deliberately has no `preview_id`; Wrangler therefore binds `MONITOR_STATE` to the production namespace. It also forces the NVIDIA model configured for this project, overriding any stale `OPENROUTER_MODEL` in `.dev.vars`. Normal `npm run dev` uses local/preview state and will not show production decisions. The dashboard routes still return `404` on the public deployed Worker.

If you run the dashboard through `npm run dev`, initialize its local D1 state once before opening `/dashboard`:

```sh
npm run db:migrate:local
```

Re-evaluating a cached decision that changes from `not_reset` or `uncertain` to `reset_confirmed` sends a subscriber alert and saves its delivery status to production KV. Other re-evaluations update the cached decision only. If OpenRouter is rate limited, the dashboard reports the error and preserves the existing production decision.

An operator can explicitly recover a fresh confirmed decision that was cached without delivery by posting `{"tweetId":"<id>","replayConfirmed":true}` to the local-only `/dashboard/re-evaluate` route. This operation reclassifies the saved post, rejects expired or seeded history, and uses the D1 delivery ledger to skip subscribers who already received the alert. Routine re-evaluation never replays an already-confirmed decision.

Trigger a manual run:

```sh
curl -X POST https://<worker-url>/run -H "Authorization: Bearer <CRON_SECRET>"
```

The first successful run seeds the watermark to the newest tweet and does not alert historical tweets. The cron trigger runs every hour after deployment.

## Public Subscription Mode

Private v1 can send to fixed `TELEGRAM_CHAT_IDS`. Only enable public subscription mode when you want users to `/subscribe` and `/unsubscribe` themselves.

Create D1 and Queue resources:

```sh
npx wrangler d1 create codex-limit-telegram-subscriptions
npx wrangler queues create codex-limit-telegram-delivery
```

Enable the commented D1, Queue, Durable Object, and migration blocks in `wrangler.toml`, then change this under the existing `[vars]` block:

```toml
PUBLIC_SUBSCRIPTIONS_ENABLED = "true"
```

Use the `database_id` printed by `wrangler d1 create` in the `SUBSCRIPTIONS_DB` binding.

Apply D1 migrations:

```sh
npm run db:migrate:remote
```

Generate `TELEGRAM_WEBHOOK_SECRET`:

```sh
openssl rand -hex 32
```

Set additional secrets:

```sh
npx wrangler secret put ADMIN_TELEGRAM_CHAT_IDS
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Deploy the updated bindings:

```sh
npm run deploy
```

Configure Telegram webhook with a secret token and restricted update types:

```sh
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "content-type: application/json" \
  -d '{
    "url": "https://<worker-url>/telegram/webhook",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>",
    "allowed_updates": ["message"],
    "drop_pending_updates": true
  }'
```

Public users can call `/subscribe`, `/unsubscribe`, and `/status`. Public Telegram commands never trigger tweet-provider calls, OpenRouter calls, or monitor runs. The monitor caches every checked tweet silently and only sends subscriber alerts for confirmed resets.

Configure Telegram's command menu buttons after deploy:

```sh
curl -X POST "https://<worker-url>/telegram/commands" \
  -H "Authorization: Bearer <CRON_SECRET>"
```

Remove the webhook if you need to disable inbound Telegram traffic:

```sh
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/deleteWebhook?drop_pending_updates=true"
```

## HTTP Routes

- `GET /health`: public health summary without raw secrets or provider error payloads.
- `GET /dashboard`: local-only cached dashboard with recent tweets, decisions, and model usage logs. Only served on localhost during development.
- `GET /dashboard.json`: local-only JSON version of the cached dashboard data. Only served on localhost during development.
- `POST /run`: authenticated manual poll using `Authorization: Bearer <CRON_SECRET>`.
- `POST /telegram/commands`: authenticated Telegram command menu setup using `Authorization: Bearer <CRON_SECRET>`.
- `POST /telegram/webhook`: optional Telegram webhook. Disabled unless `TELEGRAM_WEBHOOK_SECRET` is configured.

## Defensive Behavior

- Inbound webhook requests must include Telegram's secret-token header.
- Oversized webhook bodies are rejected.
- Duplicate Telegram `update_id` values are ignored.
- Commands are rate-limited globally and per chat.
- `/status` reads cached state only.
- Subscribers only receive confirmed reset alerts; non-reset and uncertain tweets are cached for `/status` without fanout.
- Telegram `/run` does not execute the monitor; use authenticated HTTP `/run`.
- Public fanout classifies once, enqueues delivery batches, and sends idempotently per `alert_id + chat_id`.

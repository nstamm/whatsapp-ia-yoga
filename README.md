# Ofiprof Yoga Sales Bot

Production chatbot for WhatsApp, Instagram, and Facebook leads. It combines OpenAI responses, Zernio messaging, a persistent SQLite CRM, payment delivery, reminders, Meta Ads attribution, and an authenticated operational dashboard.

## Quick Start

```bash
npm ci
cp .env.example .env
npm test
npm start
```

Node.js 22.5 or newer is required. Configure at least `OPENAI_API_KEY`, `ZERNIO_API_KEY`, `ZERNIO_ACCOUNT_ID`, and `ADMIN_TOKEN` before connecting real channels.

Useful URLs:

| URL | Purpose |
|---|---|
| `/health` | Public process health |
| `/webhook` | Provider webhook ingress |
| `/admin` | Authenticated operations dashboard |
| `/admin/api/flow` | Conversation-flow definition |
| `/admin/api/performance` | Bounded runtime performance metrics |

## Capabilities

- Multi-channel identity handling for WhatsApp, Instagram, and Facebook.
- OpenAI chat responses, audio transcription, name capture, and payment-proof analysis.
- Persistent conversation history, payments, handoffs, reminders, and settings in SQLite.
- Media delivery for product images, voice notes, and video material.
- Human handoff and post-payment product delivery.
- Meta Ads timelines, attribution, conversion reporting, and profitability metrics.
- Visual `Flujo` panel with editable prompts/messages and media previews.
- SQL-level conversation search, filtering, pagination, and indexed attribution.
- Bounded caches, provider timeouts, event-loop monitoring, and route/query timings.

## Architecture

```text
Meta/Zernio webhook
        |
        v
Express runtime --------> OpenAI
        |
        +---------------> Zernio messaging and Ads APIs
        |
        +---------------> SQLite CRM
        |
        +---------------> Server-rendered admin dashboard
```

Important files:

| Path | Responsibility |
|---|---|
| `src/index.js` | HTTP server, bot orchestration, admin routes, workers, and rendering |
| `src/store.js` | SQLite schema, migrations, CRM, attribution, reporting, and reminders |
| `src/claude.js` | OpenAI chat, transcription, and extraction helpers |
| `src/zernio.js` | Messaging, account, Ads, inbox, and conversion API client |
| `src/conversationFlow.js` | Operational graph displayed in the admin `Flujo` section |
| `src/adminPerformance.js` | Cache, date, concurrency, and admin-query helpers |
| `src/performanceMetrics.js` | Bounded HTTP, SQLite, provider, memory, and event-loop metrics |
| `tests/` | Behavior, flow-contract, cache, attribution, and SQLite integration tests |

## Configuration

Copy `.env.example` to `.env`. Never commit `.env`, SQLite files, provider payloads, or backups.

Core variables:

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI API credential |
| `ZERNIO_API_KEY` | Zernio API credential |
| `ZERNIO_ACCOUNT_ID` | Default Zernio account |
| `ADMIN_TOKEN` | Required admin credential in production |
| `PUBLIC_BASE_URL` | Public HTTPS origin used for media URLs |
| `CRM_DATA_DIR` | Optional SQLite data directory override |
| `ZERNIO_REQUEST_TIMEOUT_MS` | Outbound Zernio deadline; default 12 seconds |
| `ADMIN_ADS_CACHE_TTL_MS` | Ads dashboard cache duration; default 5 minutes |

The complete non-secret template is in `.env.example`.

## Development

```bash
npm run dev
```

Run all tests:

```bash
npm test
```

The test suite uses isolated temporary SQLite databases. It must not read or modify operational data.

### Conversation Flow Contract

Any change to routing, conditions, prompts, messages, media, reminders, payment behavior, delivery, handoff, or terminal states must update these together:

1. Runtime behavior in `src/index.js`, `src/claude.js`, or related modules.
2. Nodes, labels, edges, descriptions, or fields in `src/conversationFlow.js`.
3. `tests/conversationFlow.test.js` and the relevant behavior test.

See `AGENTS.md` for the mandatory maintenance rule.

## Docker Deployment

Create local persistence directories and configure `.env`:

```bash
mkdir -p data backups
docker compose up -d --build
docker compose ps
```

SQLite remains in `./data` and backups in `./backups`; neither belongs in Git.

Before a deployment that includes schema changes:

1. Create a consistent SQLite backup.
2. Run `npm test` against the built image.
3. Recreate the runtime and wait for Docker health to become `healthy`.
4. Verify `/health`, `/admin/api/flow`, database integrity, and logs.

Manual SQLite backup:

```bash
sh scripts/backup-sqlite.sh
```

The included `compose.yaml` is configured for the current Traefik deployment. Change its host labels before using a different domain.

## Security

- Keep the GitHub repository private unless all business assets and operational details are intentionally public.
- Require `ADMIN_TOKEN` in production and never place real tokens in documentation.
- Do not commit `.env`, `data/`, `backups/`, logs, database snapshots, or exported customer data.
- Treat webhook payloads and media URLs as untrusted input.
- Rotate credentials immediately if a secret is ever committed, even if the commit is later removed.

## License

MIT. See `LICENSE`.

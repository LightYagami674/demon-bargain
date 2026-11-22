# Demon Bargain

Real-time, mobile-first, 2–6 player multiplayer horror chat game built on Cloudflare Workers, Durable Objects (`Room`), PartyServer, React, and `@typesafe-ai/sdk` (Jev).

## Local Development

1. Install dependencies:
   ```bash
   npm ci
   ```
2. Configure your local Worker secret by copying `.dev.vars.example` to `.dev.vars` (`.dev.vars` is gitignored):
   ```bash
   cp .dev.vars.example .dev.vars
   ```
   Set `TYPESAFE_API_KEY` inside `.dev.vars`.
3. Start the local dev server:
   ```bash
   npm run dev
   ```

## Verification

```bash
npm run typecheck
npm test
npm run build
```

## Production Deployment & Secrets

### One-Time Cloudflare Secret Setup

Provision the TypeSafe API key as an encrypted Cloudflare Worker secret (never commit it):

```bash
npx wrangler secret put TYPESAFE_API_KEY
```

### Automated CI/CD (GitHub Actions)

`.github/workflows/ci-deploy.yml` runs `npm run typecheck`, `npm test`, and `npm run build` on pull requests and pushes to `main`. On push to `main`, it deploys to `*.workers.dev` via `npx wrangler deploy` using repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

### Manual Deploy Fallback

```bash
npm run deploy
```

## Observability (Workers Logs)

`wrangler.jsonc` enables Cloudflare Workers Logs (`"observability": { "enabled": true }`). The server emits single-line structured JSON logs (`src/server/logger.ts`) for Room creation/cleanup, Match start/end, WebSocket disconnects, and Jev call latency/error codes—strictly excluding raw player chat text, Whispers, Curse words, `playerToken`s, and API keys.

Stream live production logs with:

```bash
npx wrangler tail
```

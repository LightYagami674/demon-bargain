# Free-Tier Real-Time TypeScript Hosting & WebSocket Options

Research for **Demon Bargain** (mobile-first, 2–6 player real-time TypeScript WebSocket game with ephemeral in-memory Rooms), deployed and played at **$0/month**.

---

## Executive Summary & Top Recommendations

### 1. Top Pick: **Cloudflare Workers + Durable Objects** (optionally with `partyserver` + Workers Static Assets)
* **Why it wins:** It is the **only** $0/month, no-credit-card platform with **built-in stateful Room actors (Durable Objects)**, **native WebSockets with Hibernation** (rooms keep WebSocket connections open while sleeping at 0 GB-s duration cost, waking in milliseconds with zero 60-second spin-up penalty), **unlimited static asset bandwidth**, and **first-class TypeScript DX** in a single monorepo deploy (`wrangler deploy`).
* **Key caveats:**
  1. **Free-plan Durable Objects must use SQLite-backed storage** (`new_sqlite_classes` in `wrangler.jsonc`); in-memory room state is evicted when the DO hibernates or restarts, so active game state should be mirrored to DO SQLite/storage (or reconstructed from it on wake) if a room must survive mobile backgrounding/hibernation.
  2. **100,000 requests/day account-wide hard cap** (resets 00:00 UTC; excess requests error rather than bill). Incoming WebSocket messages count at a **20:1 ratio** (20 incoming WS messages = 1 request; outgoing WS messages and protocol pings are free).
  3. **10 ms CPU time per invocation** on the Free plan (I/O wait does not count; plenty for turn-based/card/social-deduction game state transitions, but unsuitable for heavy physics ticks).

### 2. Runner-Up (Traditional Node/Bun Server): **Render Web Services (Free Tier)**
* **Why it's second:** No credit card required, supports standard Node.js/Bun/TypeScript WebSocket servers (`ws`, `uWebSockets.js`, Colyseus, Socket.IO) with **750 free instance hours/month** (enough for 1 continuous service) and **active WebSocket traffic prevents spin-down**.
* **Key caveats:**
  1. **15-minute inactivity spin-down + ~1-minute cold start** when all players disconnect or go idle—painful for mobile players starting a fresh lobby after a break.
  2. **In-memory rooms are lost on spin-down or deploy** (ephemeral filesystem/RAM, 512 MB RAM / 0.1 CPU).
  3. **Hard suspension on monthly bandwidth overage** if no payment method is on file.

### Why the Others Fall Short for $0/mo Production Play
* **Fly.io:** Deprecated its permanent free Hobby allowances for new organizations; now offers a **$1 / 7-day no-CC trial**, after which machines stop until a credit card is added ([Fly.io Pricing](https://fly.io/docs/about/pricing/)).
* **Koyeb:** Requires a **credit card upfront with a $29 temporary pre-authorization hold** to use the free tier ([Koyeb Pricing](https://www.koyeb.com/pricing), [Scale-to-Zero Docs](https://www.koyeb.com/docs/run-and-scale/scale-to-zero)).
* **Railway:** Free plan after the 30-day/$5 trial gives only **$1/month usage credit**, which is insufficient to keep a 24/7 WebSocket server running (~$5+/mo at $20/vCPU + $10/GB RAM rates) ([Railway Plans](https://docs.railway.com/reference/pricing/plans)).
* **Static SPA + Managed Realtime (Ably / Supabase Realtime / Pusher):** Great free quotas and no CC required, **but they are stateless pub/sub brokers**—there is no authoritative server-side TypeScript Room loop to prevent cheating or resolve simultaneous mobile actions unless you also host an authoritative backend elsewhere.

---

## Side-by-Side Comparison

| Option | Native WS & Stateful Rooms | Cold Start / Sleep & Mobile Impact | Free-Tier Quotas | Credit Card Required? | TypeScript Monorepo & DX |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Cloudflare Workers + Durable Objects** (`partyserver` + Static Assets) | **Yes.** 1 DO = 1 single-threaded stateful Room; 32,768 WS/DO. | **WebSocket Hibernation:** keeps WS open while idle at 0 GB-s cost; wakes in ms. RAM cleared on hibernate (persist active state to DO SQLite). | **100k req/day** (incoming WS = 20:1; outgoing WS = free), **13,000 GB-s/day**, **5 GB** DO SQLite storage, **unlimited** static bandwidth. | **No** | **Excellent.** Single `wrangler deploy` serves SPA + WS backend; shared TS types in monorepo; `partyserver` simplifies rooms. |
| **Render Web Services (Free)** | **Yes.** Standard Node/Bun WS server; in-memory Rooms in RAM. | **Spins down after 15 min** with no inbound traffic/WS messages. **~1 min cold start** on wake; RAM wiped on sleep. | **750 instance hrs/mo**, 512 MB RAM, 0.1 CPU; monthly bandwidth cap (hard suspend if exceeded without CC). | **No** | **Good.** Git-push or monorepo root-dir deploy; standard Node/Bun TS build. |
| **Fly.io** | **Yes** (Docker/Node/Bun VM), but **no permanent free tier** for new orgs. | Machines can auto-stop/start in seconds, but trial ends after 7 days or $1. | **$1 starter credit / 7 days** only for new accounts; then pay-as-you-go. | **No for 7-day trial; Yes after** | **Good** (`flyctl` + Dockerfile), not permanently free. |
| **Koyeb (Free)** | **Yes.** 1 free web service (Docker/Node/Bun); RAM wiped on sleep. | **Scales to zero after 1 hr** idle (cannot disable on free); active WS prevents sleep; **1–5s cold start**. | 1 web service: **512 MB RAM, 0.1 vCPU**, 2 GB SSD (Frankfurt / Washington D.C. only). | **Yes** (with **$29** temp auth hold) | **Good.** Git/Dockerfile deploy; monorepo supported. |
| **Railway (Free)** | **Yes** (Node/Bun service), while credits last. | Always-on while credits remain; stopped when **$1/mo credit** is exhausted. | **30-day $5 trial**, then **$1/mo** credit (0.5 GB RAM, 1 vCPU max; no custom domains). | **No for trial/Free; Yes for Hobby ($5/mo)** | **Good.** Monorepo root-dir / Nixpacks deploy. |
| **Vercel / Netlify / CF Static + Ably** | **Pub/Sub only** (no authoritative server-side Room state). | Always-on managed edge; Ably handles mobile reconnects well. | Ably: **500 concurrent conn**, **500 channels**, **6M msg/mo**, 500 MAU. | **No** (Ably, CF, Vercel, Netlify) | **Split stack.** Vercel Hobby forbids commercial use; Netlify Free caps at 300 credits/mo. |
| **Static SPA + Supabase Realtime** | **Pub/Sub only** (Broadcast/Presence; Edge Functions are stateless). | Always-on managed edge; 256 KB max broadcast payload. | **200 peak concurrent conn**, **2M msg/mo**. | **No** | **Split stack.** Good TS SDK, no stateful Room server. |
| **Static SPA + Pusher Channels** | **Pub/Sub only** (stateless channels). | Always-on managed edge. | **100 concurrent conn**, **200k msg/day** (both inbound & outbound count). | **No** | **Split stack.** 100-connection cap is tight. |

---

## Detailed Platform Analysis

### 1. Cloudflare Workers + Durable Objects (`partyserver` / Agents SDK)
* **Native WebSocket & Stateful Rooms:** Each Durable Object (DO) is a globally unique, single-threaded actor—an ideal 1:1 fit for an ephemeral 2–6 player game Room ([Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)). Supports up to **32,768 simultaneous WebSocket connections per DO** and **32 MiB** max received message size ([Durable Objects Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)). Using `partyserver` (the Cloudflare-maintained successor to PartyKit) or the Cloudflare Agents SDK wraps DO WebSocket lifecycle, room routing, and broadcasting cleanly ([Cloudflare Agents](https://developers.cloudflare.com/agents/), [PartyKit/PartyServer Repo](https://github.com/cloudflare/partykit)).
* **Cold-Start, Sleep & Mobile Behavior:** Using the **WebSocket Hibernation API** (`ctx.acceptWebSocket()`), an idle DO drops from memory **without closing client WebSockets** and incurs **0 GB-s compute duration** while waiting ([Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)). When a mobile player sends a message or reconnects, the DO wakes in milliseconds. **Important caveat:** hibernation clears in-memory JS variables, so Room state must be persisted in the DO's embedded **SQLite storage** (available on the Free plan) and lazily rehydrated in the constructor/wake handler ([Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
* **Free-Tier Limits (reset daily at 00:00 UTC):**
  * **100,000 requests/day** shared across Workers and DOs ([Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
  * Incoming WebSocket messages count at a **20:1 ratio** (100 incoming messages = 5 requests); **outgoing WebSocket messages and protocol pings are free** ([Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
  * **13,000 GB-s/day** DO compute duration; **5 GB** account-wide DO SQLite storage; **100 DO classes** max ([Durable Objects Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)).
  * **10 ms CPU time** per Worker/DO invocation, **128 MB** memory per isolate ([Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)).
  * **Workers Static Assets:** Serving your Vite/React/Svelte SPA from the same Worker has **unlimited free bandwidth and static requests** (up to 20,000 files, 25 MiB/file on Free) ([Workers Static Assets Billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)).
* **Credit Card Required:** **No** ([Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/)).
* **TypeScript Monorepo DX:** First-class. One `wrangler.jsonc` can bundle both the static frontend assets and the Worker + DO backend, sharing a `packages/shared` TypeScript protocol package with zero CORS or multi-vendor deployment drift.

### 2. Render Web Services (Free Tier)
* **Native WebSocket & Stateful Rooms:** Full Node.js/Bun/Docker support for standard WebSocket servers (`ws`, Socket.IO, Colyseus) with in-memory Rooms ([Render Free Tier](https://render.com/docs/free)).
* **Cold-Start, Sleep & Mobile Behavior:** Free web services **spin down after 15 minutes** without inbound traffic; **active WebSocket connections sending/receiving messages keep the service awake**, but once idle for 15 minutes it sleeps and takes **~1 minute to spin back up** on the next connection ([Render Free Tier](https://render.com/docs/free)). All in-memory room state is lost on spin-down.
* **Free-Tier Limits:** **750 free instance hours/month** (512 MB RAM, 0.1 CPU); exceeding monthly outbound bandwidth suspends free services until the next month when no card is attached ([Render Free Tier](https://render.com/docs/free), [Render Pricing](https://render.com/pricing)).
* **Credit Card Required:** **No** ([Render Free Tier](https://render.com/docs/free)).
* **TypeScript Monorepo DX:** Good—supports root directory configuration and custom build/start commands in a monorepo, though frontend static site and backend web service are separate Render services.

### 3. Fly.io
* **Free Tier Status:** Fly.io **discontinued its permanent free Hobby allowances** for new organizations. New accounts receive a **$1 starter credit valid for 7 days** without a credit card (capped at 10 machines, no dedicated IPv4); once the $1 or 7 days expire, machines stop and a **credit card is required** ([Fly.io Pricing](https://fly.io/docs/about/pricing/)).
* **Verdict:** Not viable for permanent $0/month hosting.

### 4. Koyeb
* **Native WebSocket & Stateful Rooms:** 1 free web service (512 MB RAM, 0.1 vCPU, 2 GB SSD) in Frankfurt or Washington, D.C. ([Koyeb Pricing](https://www.koyeb.com/pricing)).
* **Cold-Start & Sleep Behavior:** Scales to zero after **1 hour** of inactivity (cannot be disabled on Free); active WebSockets prevent sleep, and cold starts take **1–5 seconds** ([Koyeb Scale-to-Zero](https://www.koyeb.com/docs/run-and-scale/scale-to-zero)).
* **Credit Card Required:** **Yes**—requires a credit card at sign-up with a **$29 temporary pre-authorization hold** for anti-abuse verification ([Koyeb Pricing](https://www.koyeb.com/pricing)).
* **Verdict:** Disqualified if "no credit card required" is a requirement, and limited to US-East/EU-Central regions.

### 5. Railway
* **Free Tier Status:** New accounts get a **30-day / $5 one-time trial** (no CC). Afterward, the **Free plan** provides **$1/month of usage credit** (max 1 project, 3 services, 0.5 GB RAM, 1 vCPU, no custom domains) ([Railway Plans](https://docs.railway.com/reference/pricing/plans)). Because Railway bills usage continuously (~$20/vCPU/mo + ~$10/GB RAM/mo), $1/month cannot sustain an always-on WebSocket server for a full month.
* **Verdict:** Great for paid Hobby ($5/mo), but not viable as a permanent $0/mo always-on WebSocket host.

### 6. Static SPA + Managed Realtime (Ably / Supabase Realtime / Pusher)
* **Static SPA Hosts:**
  * **Cloudflare Pages / Workers Static Assets:** **Unlimited free bandwidth**, 500 builds/mo, no CC, commercial use allowed ([Workers Static Assets Billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)).
  * **Vercel Hobby:** 100 GB Fast Data Transfer/mo, no CC, **strictly non-commercial personal use only** ([Vercel Limits](https://vercel.com/docs/limits/overview), [Vercel Monorepos](https://vercel.com/docs/monorepos)).
  * **Netlify Free:** **300 credits/mo hard cap** (20 credits/GB bandwidth = ~15 GB max; 15 credits per production deploy = ~20 deploys max) ([Netlify Pricing](https://www.netlify.com/pricing/)).
* **Managed Realtime Brokers (no authoritative server-side Room state):**
  * **Ably Free:** **500 concurrent connections, 500 concurrent channels, 6M messages/mo, 500 MAUs**, no CC, throttles rather than bills on overage ([Ably Pricing](https://ably.com/pricing)).
  * **Supabase Realtime Free:** **200 peak concurrent connections, 2M messages/mo**, 256 KB max broadcast payload, no CC ([Supabase Realtime Limits](https://supabase.com/docs/guides/realtime/limits), [Supabase Pricing](https://supabase.com/pricing)).
  * **Pusher Channels Sandbox:** **100 concurrent connections, 200k messages/day** (both inbound and outbound deliveries count), no CC ([Pusher Pricing](https://pusher.com/channels/pricing/)).
* **Verdict:** Only suitable if game state is peer-trusted/host-migrated in the browser, or if paired with a separate stateful server—which brings you back to needing a backend host.

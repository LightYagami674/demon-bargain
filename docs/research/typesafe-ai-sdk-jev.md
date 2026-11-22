# Research: `@typesafe-ai/sdk` (Jev) API, Latency & Provider Fit

> **Ticket:** `LightYagami674/demon-bargain#3`  
> **Package Inspected:** `@typesafe-ai/sdk@0.7.0` (Node.js `>= 22`, zero runtime dependencies, MIT license)  
> **Primary Sources:** Unpacked npm tarball (`package.json`, `README.md`, `dist/index.d.mts`, `dist/index.mjs`), [TypeSafe Docs](https://docs.typesafe.ai/), [Models](https://docs.typesafe.ai/models.md), [System One](https://docs.typesafe.ai/concepts/system-one.md), [Quickstart](https://docs.typesafe.ai/introduction/quickstart.md), [Errors & Request Rules](https://docs.typesafe.ai/api/errors.md), [Parallel Questions Cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions.md).

---

## Executive Summary

1. **Hosted System One API (Not a BYO-LLM Wrapper):** `@typesafe-ai/sdk` does **not** wrap OpenAI, Gemini, Groq, Cerebras, or OpenRouter, and does **not** accept third-party LLM API keys. It talks exclusively to TypeSafe AI's own hosted endpoint (`POST https://api.typesafe.ai/v1/systemone`) using `TYPESAFE_API_KEY` and TypeSafe's **Jev** model (`jev-latest` → `jev-1.14.0`).
2. **Exact Client Name:** The SDK exports `TypeSafeClient` (not `jev`), and the evaluation method is `client.systemOne(...)`. Question builders are `noul`, `choice`, `score`, and `box`.
3. **Judgment-Only (No Text Generation):** Jev is a **System One** model—it evaluates `state` against typed `questions` in a single parallel forward pass and returns calibrated probabilities/scores (`noul`, `choice`, `score`, `box`). It **cannot** generate Entity dialogue, taunts, or prose; those must be templated or produced by a separate generative model.
4. **Cost & Free-Tier Reality:** Jev costs **$0.042 per 1M input tokens** ($42 / 1B) and **$0.00 for output tokens**. There is **no permanently guaranteed free-tier subscription** (pay-as-you-go; promotional sign-up credits such as $5 test credits have been offered in the console). At ~500–800 input tokens per batched message judgment, 1,000 player messages cost **~$0.02–$0.03** (fractions of a cent per Match).
5. **Latency & Concurrency Fit (2–6 Players):** Typical end-to-end latency is **~70–500 ms**, and batching all per-message questions (`noul` + `choice` + `score`) into one `systemOne()` call incurs the `state` token cost and round-trip only once. With `10,000 ms` default per-attempt timeout, automatic retries (`maxRetries: 2`), and stateless `fetch` transport, a singleton `TypeSafeClient` on the server easily handles 2–6 players chatting concurrently.

---

## 1. Verified TypeScript API (`@typesafe-ai/sdk@0.7.0`)

Verified directly from `dist/index.d.mts`, `dist/index.mjs`, and `README.md` in `@typesafe-ai/sdk@0.7.0`.

### Installation & Runtime Requirements
- **Install:** `npm install @typesafe-ai/sdk`
- **Runtime:** Node.js `>= 22` (`package.json` `engines.node`). Zero runtime dependencies. ESM (`./dist/index.mjs`), CJS (`./dist/index.cjs`), and TypeScript declarations (`./dist/index.d.mts`, `./dist/index.d.cts`).
- **Browser guard:** `new TypeSafeClient()` throws `TypeSafeError` in browser environments unless `dangerouslyAllowBrowser: true` is set. Always run `TypeSafeClient` on the server to keep `TYPESAFE_API_KEY` secret.

### Initialization (`TypeSafeClient` & `ENV`)
```ts
import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";

// Reads TYPESAFE_API_KEY from process.env by default.
// Optional env vars: TYPESAFE_BASE_URL, TYPESAFE_DEFAULT_MODEL, TYPESAFE_LOG_LEVEL
const client = new TypeSafeClient({
  apiKey: process.env.TYPESAFE_API_KEY, // default: process.env.TYPESAFE_API_KEY
  baseURL: "https://api.typesafe.ai",   // default
  defaultModel: "jev-latest",           // default (resolves to "jev-1.14.0")
  timeout: 10_000,                      // default: 10,000 ms per attempt
  retry: { maxRetries: 2 },             // default: 2 retries (3 total attempts)
  compression: "zstd",                  // default on Node >= 22.15 for bodies >= 1 KiB
});
```

### Question Primitives & Return Shapes

| Builder | Signature (`dist/index.d.mts`) | Returned Answer Shape (`ResultFor<Q>`) | Notes |
| :--- | :--- | :--- | :--- |
| `noul(instructions, criteria?)` | `(instructions: EntryType, criteria?: { true?: EntryType; false?: EntryType } \| null) => NoulQuestion` | `{ type: "noul"; noul: number }` | `noul` is probability `0..1` of `true`. |
| `choice(instructions, criteria)` | `<T extends ChoiceCriteria>(instructions: EntryType, criteria: T) => ChoiceQuestion<T>` | `{ type: "choice"; choice: keyof T & string; confidence: number; probabilities: Record<keyof T, number> }` | `criteria` is `{ [label]: description \| null }`. |
| `score(instructions, criteria)` | `<T extends ScoreCriteria>(instructions: EntryType, criteria: T) => ScoreQuestion<T>` | `{ type: "score"; score: number; confidence: number; legend: ScoreLegend<T>; probabilities: Record<ScoreOf<T>, number> }` | `criteria` tuple of 2–10 ordered descriptions (indexed `0..n-1`); `score` is expected value `sum(i * p_i)`. |
| `box(instructions?)` | `(instructions?: EntryType) => BoxQuestion` | `{ type: "box"; box: { top, bottom, left, right }; confidence: number \| null }` | Requires `jev-1.14.0` / `jev-preview` + image in `state`. |

### Batched `client.systemOne()` Example (Demon Bargain Judgment Pattern)
```ts
import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";

const client = new TypeSafeClient();

const result = await client.systemOne({
  // state can be string, JSON object, or array (and optionally include images)
  state: {
    entityMood: "SADIST",
    activeCurseWord: "lantern",
    recentContext: ["PlayerB: Please spare me!", "PlayerA: Take PlayerB instead!"],
    playerMessage: "I'd gladly trade PlayerB's soul if you keep my lantern lit.",
  },
  questions: {
    pleaQuality: score("How compelling is this plea under the SADIST mood?", [
      "Boring, weak, or off-topic",
      "Mildly entertaining or desperate",
      "Deliciously cruel, dramatic, or manipulative",
    ]),
    isSpamOrGibberish: noul("Is the message low-effort spam, gibberish, or empty filler?", {
      true: "Repeated characters, random letters, or zero-effort filler",
      false: "A coherent in-game message or plea",
    }),
    curseIncludedNaturally: noul("Does the message include the word 'lantern' naturally in a sentence?", {
      true: "Contains 'lantern' woven naturally into the plea",
      false: "Missing 'lantern' or tacked on unnaturally",
    }),
    tone: choice("What is the primary social tactic?", {
      betrayal: "Throwing another player under the bus",
      groveling: "Begging for mercy",
      defiance: "Challenging or mocking the Entity",
    }),
  },
});

// Strongly typed from the `questions` object:
result.model;                               // e.g. "jev-1.14.0"
result.answers.pleaQuality.score;           // number (0..2)
result.answers.pleaQuality.confidence;      // number (0..1)
result.answers.isSpamOrGibberish.noul;      // number (0..1)
result.answers.curseIncludedNaturally.noul; // number (0..1)
result.answers.tone.choice;                 // "betrayal" | "groveling" | "defiance"
result.usage.input_tokens;                  // number | null
result.usage.output_tokens;                 // number | null
```

`client.systemOne()` returns an `APIPromise<SystemOneResult<Q>>`, which also exposes `.withResponse()` (returns `{ data, response, requestId }`) and `.asResponse()`.

---

## 2. Hosted Endpoint, Auth, Pricing & Rate Limits

- **Endpoint & Auth:** `POST https://api.typesafe.ai/v1/systemone` (and `GET https://api.typesafe.ai/v1/models`) with `Authorization: Bearer <TYPESAFE_API_KEY>`.
- **Models (`docs.typesafe.ai/models.md`):**
  - `jev-1.14.0` (current `jev-latest` and `jev-preview`, released Oct 14, 2026): supports `Choice`, `Score`, `Noul`, `Box`; text & PNG/JPEG images.
  - `jev-1.13.0`: supports `Choice`, `Score`, `Noul`.
  - Context limits: **64k tokens per-request** (`state` + all questions) and **32k tokens per-question** (`state` + any single question). Sending `TypeSafe-Danger-Zone-Long-Context: true` raises both to **262k tokens** (slower/less accurate).
- **Pricing (`docs.typesafe.ai/models.md`, `cookbooks/parallel_questions.md`):**
  - **Input:** **$0.042 per 1M tokens** ($42 / 1B tokens).
  - **Output:** **$0.00** (output tokens are free).
  - **Free tier:** No permanent free-tier subscription plan; pay-as-you-go token billing (console accounts have periodically received small promotional sign-up credits, e.g., $5, for testing).
  - **Demon Bargain cost estimate:** A batched judgment with ~600 input tokens costs `600 / 1,000,000 * $0.042 = $0.0000252` (**~2.5 cents per 1,000 messages**). Even a busy 6-player Match with 200 judged messages costs **~$0.005** (< 1 cent).
- **Rate Limits (`docs.typesafe.ai/models.md`):**
  - Enforced per organization in **requests per second (RPS)** and **tokens per second (TPS)** (visible in `console.typesafe.ai/rate-limits`; custom/enterprise increases via support form).
  - Exceeding limits returns `429 Too Many Requests` (with `retry-after` / `retry-after-ms` when present); temporary capacity spikes return `529 Overloaded`.

---

## 3. Latency, Overhead, Error Handling & Concurrency (2–6 Players)

### Latency & Batching Overhead
- **Single-pass parallel scoring:** Jev ingests `state` once and evaluates all questions in `questions` in parallel without autoregressive text generation. Typical end-to-end latency is **~70–500 ms**.
- **Why batching matters:** In TypeSafe's [Parallel Questions cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions.md) (13 questions over a ~54k-char document), batching all questions into 1 `systemOne()` call was **12.2x cheaper** and **11.8x faster** than 13 separate calls, with **zero accuracy/consistency loss** (each question is scored independently against `state`).
- **Compression:** On Node `>= 22.15`, `@typesafe-ai/sdk` automatically zstd-compresses request bodies `>= 1 KiB` (`dist/index.mjs`), keeping payload overhead minimal.

### Error Handling & Retry Policy (`dist/index.mjs`, `dist/index.d.mts`)
Default `TypeSafeClient` retry & timeout behavior:
- **Timeout:** `10,000 ms` per HTTP attempt (no total retry budget; override per-call via `options.timeout` or `options.signal`).
- **Retries:** `maxRetries: 2` (up to 3 attempts), `backoffInitialMs: 500`, `backoffMaxMs: 5000`, `backoffJitter: 0.25`.
- **Retryable failures:** HTTP `408`, `429`, `500–599` (including `529 Overloaded`), `APIConnectionError`, and `APITimeoutError`. Honors `retry-after-ms` / `Retry-After` up to `60,000 ms`.
- **Typed Error Hierarchy:** `TypeSafeError` → `APIError` (`BadRequestError` 400, `AuthenticationError` 401, `PermissionDeniedError` 403, `NotFoundError` 404, `UnprocessableEntityError` 422, `RateLimitError` 429, `InternalServerError` 5xx), `APIConnectionError`, `APITimeoutError`, `APIUserAbortError`.

### Concurrency Behavior for 2–6 Players
- `TypeSafeClient` is stateless (wraps `fetch`), so a single server-side instance can safely serve all Rooms concurrently.
- For 2–6 players chatting in real time (typically 0.5–3 messages/sec per Room), firing one batched `client.systemOne()` call per message in parallel (`async` per message, non-blocking to chat broadcast) keeps chat UI instant while applying Doom updates ~100–500 ms later.
- **Resilience tip for a real-time game:** Set a tighter per-call `timeout` (e.g., `2500`–`3000` ms) and `maxRetries: 1` for live chat judgments, with a deterministic fallback (e.g., `0` Doom delta) on `APITimeoutError` / `RateLimitError` so a transient API hiccup never stalls a round.

---

## 4. Implications for Demon Bargain Architecture

1. **One `systemOne()` call per judged event:** Combine `Entity Mood` scoring, spam detection (`noul`), `Curse` compliance (`noul`), and tone/betrayal classification (`choice`) into a single `questions` map per player message.
2. **Use `Whisper` interception as a separate batched call (or trigger):** When a `Whisper` is sent, a single `systemOne()` call with `noul` ("Is this whisper plotting betrayal or referencing another player?") + `score` ("How juicy/dramatic is this secret?") can drive interception probability.
3. **Entity Dialogue Gap:** Because Jev only outputs structured judgments (never prose), the Entity's spoken taunts/mockery must either use **authored template pools** keyed by `(EntityMood, tone.choice, pleaQuality.score)` or a **separate generative LLM** (e.g., Gemini/Groq free tier).

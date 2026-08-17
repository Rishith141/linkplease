# Known Limitations and Failure Modes

## What Is Implemented ✅

**Part A – Core Reliability:**
- ✅ Rule matching (case-insensitive, substring match anywhere in comment)
- ✅ Event deduplication by `event_id` (events added to `processedEvents` only AFTER job is safely recorded)
- ✅ User+rule deduplication (same user never receives two DMs for the same rule, even across multiple comments)
- ✅ Retry on 500 errors (exponential backoff: 4s → 8s → 16s, max 3 attempts)
- ✅ Retry on 429 errors (respects `Retry-After` header, pauses whole worker)
- ✅ 400 errors are not retried
- ✅ Network/timeout errors treated as retryable with idempotency key preventing double-send
- ✅ `sent` only increments after `GET /v1/dm/{dm_id}` confirms `status == "delivered"`
- ✅ `failed` only increments after retries are exhausted or 400 error
- ✅ `queued` includes both unsent outbound jobs AND accepted DMs awaiting delivery confirmation
- ✅ `duplicates_blocked` increments only when a valid duplicate is correctly prevented
- ✅ Global outbound DM queue — all webhook events share one rate limiter (max 10/60s)
- ✅ `comment.deleted` cancels pending unsent jobs for that comment_id

**Part B – Webhook Security:**
- ✅ HMAC-SHA256 signature verified on raw request body
- ✅ Missing signature → 401
- ✅ Invalid signature → 401
- ✅ `crypto.timingSafeEqual` prevents timing side-channel
- ✅ `express.json({ verify })` captures raw body cleanly without stream conflicts
- ✅ `/webhook` responds HTTP 200 within 5 seconds (all processing is async via `setImmediate`)

---

## Remaining Limitations (Honest)

### 1. In-Memory Storage — Not Persistent Across Restarts

All state (`rules`, `processedEvents`, `userRuleState`, `outboundQueue`, `cancelledComments`) lives strictly in Node.js process memory (`Map`, `Set`, `Array`).

- **Process Restart Behavior:** If the server restarts (e.g. Render auto-deploy, crash, dyno sleep, manual restart), all in-memory state is wiped clean.
- **Rules lost:** Created rules vanish and must be recreated via `POST /rules`.
- **Queued DM loss:** Any jobs waiting in `outboundQueue` to be sent are lost and will not be dispatched.
- **Accepted DMs (`accepted` state):** DMs accepted by PseudoGram (202 status) that are awaiting delivery confirmation will stop being polled. `stats.sent` will not increment for them even if PseudoGram eventually delivers them.
- **Deduplication reset:** `userRuleState` and `processedEvents` are cleared, so subsequent comments after a restart could trigger a new DM even if the same user previously received one.
- **Design Rationale:** For this reliability assignment, an in-memory design keeps code simple, transparent, and easy to explain in a Loom/interview without adding database ORM abstractions. SQLite/PostgreSQL persistence would be required for a production deployment.

---

### 4. comment.deleted Lifecycle Behavior & Limitations

We track deleted comments in `cancelledComments = new Set()`.

- **Sequence 1: `comment.created` → `queued` → `comment.deleted` → `cancelled` (Handled ✅)**
  If a `comment.deleted` event arrives while the DM job is still waiting in `outboundQueue`, the worker detects `cancelledComments.has(job.commentId)` before calling `POST /v1/dm/send` and cancels the job. No DM is sent.
- **Sequence 2: `comment.created` → `202 accepted` → `comment.deleted` (Cannot Undo ⚠️)**
  If the DM job was already sent to PseudoGram and returned `202 Accepted`, a subsequent `comment.deleted` event cannot recall or cancel the DM. PseudoGram does not provide a `DELETE /v1/dm/{dm_id}` API, so the DM delivery pipeline proceeds normally.
- **Race Condition:** There is a microsecond window between when a job is dequeued from `outboundQueue` and when `POST /v1/dm/send` is invoked. If `comment.deleted` arrives in that exact window, the job may still be sent.

### 5. Delivery Polling Is Not Guaranteed to Converge Before Restart

- **Behavior:** We poll `GET /v1/dm/{dm_id}` every 3 seconds for all `accepted` DMs.
- **If the DM is stuck in `queued` state on PseudoGram's side for a long time:** Our stats correctly show it as `queued` until PseudoGram resolves it.
- **If server restarts while DMs are in `accepted` state:** Polling stops. Stats will not update.

### 6. Replay Attacks Not Prevented

HMAC-SHA256 verifies authenticity (that the request was signed with our key) but not freshness.

- **Attack:** An attacker who intercepts a valid signed webhook payload could replay it later.
- **Mitigation:** Would require timestamp validation (e.g., reject webhooks older than 5 minutes). Not implemented because the spec does not include a timestamp in the signature scheme.

### 7. No Horizontal Scaling

The in-memory rate limiter (`sendTimestamps` array) and job queue exist only in the single Node.js process.

- **Impact:** If deployed as multiple instances (e.g., multiple Render workers), each would have an independent queue and rate limiter, potentially exceeding the 10 req/60s limit together.
- **Mitigation:** Would require Redis-based shared queue/rate limiter for multi-instance deployments.

---

## Test Matrix

| Scenario | Handled? |
|---|---|
| Comment with matching keyword | ✅ Sends DM |
| Comment with non-matching keyword | ✅ Ignored |
| Same user comments twice (same rule) | ✅ Second DM blocked |
| Duplicate `event_id` delivered twice | ✅ Second event skipped |
| Webhook delivered twice (different `event_id`) | ✅ Second DM blocked via userRuleState |
| API returns 202, then `delivered` | ✅ `sent` increments |
| API returns 202, then `failed` (DM delivery) | ✅ `failed` increments |
| API returns 500 | ✅ Retried up to 3x with backoff |
| API returns 429 with Retry-After | ✅ Whole worker paused, job re-queued |
| API returns 400 | ✅ Job permanently failed, no retry |
| Network timeout on send | ✅ Treated as retryable (unknown outcome) |
| Forged webhook (wrong signature) | ✅ Rejected with 401 |
| Missing signature header | ✅ Rejected with 401 |
| `comment.deleted` before DM sent | ✅ Job cancelled |
| `comment.deleted` after DM accepted | ⚠️ Cannot undo – DM may still deliver |
| 10+ rapid webhooks (rate limiter test) | ✅ Queued; max 10/60s enforced |
| Server restart during processing | ❌ All in-memory state lost |
| Multiple instances deployed | ❌ Rate limit not coordinated across instances |

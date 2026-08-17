# Known Limitations and Failure Modes

## Part A & B Implementation ✅

**Part A:** Rule matching, webhook event deduplication, DM sending, stats tracking  
**Part B:** Webhook signature verification (HMAC-SHA256 validation), rejects forged requests with 401

---

## Critical Path Issues

1. **In-Memory Storage Loss on Restart**
   - All rules, deduplication state, and DM tracking live in Node.js process memory.
   - If the server restarts (Render auto-deploy, crash), all pending DMs and dedup state are lost.
   - Previously sent DMs won't be re-sent, but the API won't know they were already attempted.
   - **Condition:** Any server restart while DMs are in flight or queued.

2. **Rate Limit Handling**
   - When rate-limited (429), DMs are marked as queued but not actively retried.
   - The retry loop checks status every 5 seconds, but doesn't re-attempt the send.
   - **Condition:** Burst of comments hitting rate limit; may result in queued DMs that never retry.

3. **Stats Accuracy Under Extreme Load**
   - Stats counting is based on in-memory counters that increment on send, not on actual API confirmation.
   - Under 500 events in 10 seconds, the background status check (every 5s) cannot keep pace.
   - **Condition:** High concurrency and rapid event delivery; queued count may be inflated.

## Edge Cases

4. **Duplicate Detection Race Condition**
   - If two identical events (same event_id) arrive within ~50ms, both may pass the dedup check before either writes to `sentDMs`.
   - Result: User gets DM twice for same rule.
   - **Condition:** Webhook receives same event_id from LinkPlease API within microseconds, both hit different Node.js processes (unlikely on single instance, but possible under load balancing).

5. **Comment Deleted Before DM Sent**
   - If a `comment.deleted` event arrives before the DM is sent, we currently just log it.
   - No way to prevent sending a DM for a deleted comment.
   - **Condition:** Delete happens milliseconds after comment is posted.

6. **Signature Verification Cannot Detect Replay Attacks**
   - HMAC-SHA256 validates that a webhook is authentic, but doesn't protect against replay (resending old events).
   - LinkPlease handles this via event_id deduplication on our side, but a sophisticated attacker with old signed payloads could theoretically replay them.
   - **Condition:** Unlikely but theoretically possible if old webhook logs are compromised.

## What Works Reliably

- Deduplication on single process (same user + rule only gets one DM per server run)
- Rule matching (case-insensitive keyword search)
- 200-response on webhook (events not lost mid-request)
- Stats endpoint returns current counts (not necessarily real-time truth)
- Webhook signature verification (forged requests rejected)
- Async webhook processing (doesn't block LinkPlease's API)

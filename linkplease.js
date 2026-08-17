require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

// ============================================
// CONFIGURATION
// ============================================
const API_BASE = 'https://pseudogram-api.onrender.com';
const API_KEY = process.env.API_KEY;
const PORT = process.env.PORT || 3000;

// ============================================
// MIDDLEWARE: Raw body capture for signature verification
//
// express.json's `verify` callback receives the raw buffer
// BEFORE JSON.parse() runs, so we save it as req.rawBody.
// This way req.body (parsed JSON) and req.rawBody (raw string)
// are both available, solving the stream-consumption problem.
// ============================================
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));

// ============================================
// IN-MEMORY STATE
// ============================================

// rules: Map of rule_id -> { keyword (lowercased), dm_message }
const rules = new Map();

// processedEvents: Set of event_ids we have fully handled.
// An event is only added here AFTER the corresponding DM job
// is safely recorded in outboundJobs or userRuleState.
// This prevents the "mark-before-queue" crash window.
const processedEvents = new Set();

// userRuleState: Map of `${ruleId}_${userId}` -> job state.
// State values: 'queued' | 'accepted' | 'delivered' | 'failed'
// 'queued'   = job is in outboundQueue, not yet sent
// 'accepted' = POST /v1/dm/send returned 202; awaiting delivery
// 'delivered' = GET /v1/dm/{dm_id} returned 'delivered'
// 'failed'   = all retries exhausted or 400 error
//
// We set this BEFORE marking the event as processed,
// so a duplicated event_id sees the existing state and is blocked.
const userRuleState = new Map(); // key -> { state, dm_id, retries, retryAfter, commentId }

// cancelledComments: Set of comment_ids from comment.deleted events.
// Before sending a DM job, we check if its comment_id was cancelled.
const cancelledComments = new Set();

// stats counters
const stats = {
  sent: 0,
  failed: 0,
  duplicates_blocked: 0
};

// ============================================
// OUTBOUND DM QUEUE & RATE LIMITER
//
// All DM sends go through this queue to enforce:
//   max 10 POST /v1/dm/send per rolling 60 seconds
//
// outboundQueue: array of jobs waiting to be sent.
// sendTimestamps: timestamps of recent sends within the 60s window.
// ratePaused: set to a future timestamp when Retry-After is received.
//   The worker will not send until Date.now() >= ratePaused.
// ============================================
const outboundQueue = []; // { key, userId, ruleId, commentId, retries, retryAfter }
const sendTimestamps = [];  // timestamps of POSTs sent in the last 60s
let ratePaused = 0;         // epoch ms. Worker waits until Date.now() >= this

// Runs every 1 second. Checks if we can send and dispatches one job at a time.
setInterval(processOutboundQueue, 1000);

async function processOutboundQueue() {
  const now = Date.now();

  // If a 429 Retry-After is still in effect, wait.
  if (now < ratePaused) return;

  // Clean timestamps older than 60 seconds from the window.
  while (sendTimestamps.length > 0 && sendTimestamps[0] <= now - 60000) {
    sendTimestamps.shift();
  }

  // If we've already hit 10 sends in the last 60 seconds, wait.
  if (sendTimestamps.length >= 10) return;

  // Find the next job that is ready (respects per-job retryAfter too).
  const idx = outboundQueue.findIndex(job => job.retryAfter <= now);
  if (idx === -1) return; // Nothing ready

  // Take the job out of the queue.
  const [job] = outboundQueue.splice(idx, 1);

  // If the comment was deleted before we could send, cancel this job.
  if (cancelledComments.has(job.commentId)) {
    console.log(`[CANCELLED] Job for ${job.key} – comment ${job.commentId} was deleted`);
    // Clean up userRuleState so stats don't count this as queued
    userRuleState.delete(job.key);
    return;
  }

  // Also verify rule still exists (edge case: rule was never deleted in
  // this spec, but being defensive).
  const rule = rules.get(job.ruleId);
  if (!rule) {
    console.log(`[CANCELLED] Job for ${job.key} – rule ${job.ruleId} no longer exists`);
    userRuleState.delete(job.key);
    return;
  }

  // Record the send timestamp BEFORE the request (conservative; prevents
  // racing a second tick into the window).
  sendTimestamps.push(Date.now());

  console.log(`[SEND] Attempting DM for ${job.key} (attempt ${job.retries + 1})`);

  try {
    const response = await axios.post(
      `${API_BASE}/v1/dm/send`,
      {
        recipient_user_id: job.userId,
        message: rule.dm_message,
        comment_id: job.commentId
      },
      {
        headers: {
          'X-API-Key': API_KEY,
          // Idempotency-Key is stable for this logical user+rule DM operation.
          // If we retry, PseudoGram will recognize the key and not send twice.
          'Idempotency-Key': `${job.ruleId}_${job.userId}`
        },
        timeout: 10000
      }
    );

    // 202 Accepted – DM is in PseudoGram's queue; not yet delivered.
    const { dm_id } = response.data;
    console.log(`[ACCEPTED] dm_id=${dm_id} for ${job.key}`);

    // Update state: awaiting delivery confirmation (poll loop handles this).
    userRuleState.set(job.key, {
      state: 'accepted',
      dm_id,
      commentId: job.commentId,
      retries: job.retries
    });

  } catch (error) {
    const status = error.response?.status;

    if (status === 429) {
      // Rate limited by PseudoGram. Read Retry-After (seconds).
      const retryAfterSeconds = parseInt(error.response.headers['retry-after'] || '10', 10);
      console.log(`[429] Rate limited. Retry-After: ${retryAfterSeconds}s`);

      // Pause the whole worker until this window clears.
      ratePaused = Date.now() + retryAfterSeconds * 1000;

      // Put the job back into the queue to retry after the pause.
      job.retryAfter = ratePaused;
      job.retries += 1;

      if (job.retries < 3) {
        outboundQueue.push(job);
      } else {
        console.log(`[FAILED] ${job.key} – max retries exceeded after 429`);
        userRuleState.set(job.key, { state: 'failed', commentId: job.commentId });
        stats.failed += 1;
      }

    } else if (status === 500 || !status) {
      // 500 Server error or network timeout. Retry with exponential backoff.
      job.retries += 1;
      const backoffMs = Math.pow(2, job.retries) * 2000; // 4s, 8s, 16s
      job.retryAfter = Date.now() + backoffMs;
      console.log(`[500] Server error for ${job.key}. Retry ${job.retries} in ${backoffMs}ms`);

      if (job.retries < 3) {
        outboundQueue.push(job); // Back in queue
      } else {
        console.log(`[FAILED] ${job.key} – max retries exceeded after 500`);
        userRuleState.set(job.key, { state: 'failed', commentId: job.commentId });
        stats.failed += 1;
      }

    } else if (status === 400) {
      // Bad request. Do not retry.
      console.log(`[400] Bad request for ${job.key}. Giving up.`);
      userRuleState.set(job.key, { state: 'failed', commentId: job.commentId });
      stats.failed += 1;

    } else {
      // Unknown error. Treat as retryable (we don't know the outcome).
      job.retries += 1;
      job.retryAfter = Date.now() + 5000;
      console.log(`[ERROR] Unknown error for ${job.key}: ${error.message}`);

      if (job.retries < 3) {
        outboundQueue.push(job);
      } else {
        userRuleState.set(job.key, { state: 'failed', commentId: job.commentId });
        stats.failed += 1;
      }
    }
  }
}

// ============================================
// DELIVERY STATUS POLLING LOOP
//
// Every 3 seconds, check all 'accepted' DMs by calling
// GET /v1/dm/{dm_id}. Only increments stats.sent when
// PseudoGram confirms status == 'delivered'.
// ============================================
setInterval(async () => {
  for (const [key, info] of userRuleState.entries()) {
    if (info.state !== 'accepted') continue;

    try {
      const response = await axios.get(
        `${API_BASE}/v1/dm/${info.dm_id}`,
        {
          headers: { 'X-API-Key': API_KEY },
          timeout: 5000
        }
      );

      const deliveryStatus = response.data.status;

      if (deliveryStatus === 'delivered') {
        console.log(`[DELIVERED] dm_id=${info.dm_id} for ${key}`);
        userRuleState.set(key, { ...info, state: 'delivered' });
        stats.sent += 1;

      } else if (deliveryStatus === 'failed') {
        console.log(`[DM-FAILED] dm_id=${info.dm_id} for ${key}`);
        userRuleState.set(key, { ...info, state: 'failed' });
        stats.failed += 1;
      }
      // 'queued' = still in-flight, keep polling
    } catch (error) {
      console.error(`[POLL-ERROR] Could not check dm_id=${info.dm_id}: ${error.message}`);
    }
  }
}, 3000);

// ============================================
// HELPER: Enqueue a DM job
//
// Registers the user-rule pair as 'queued' first,
// THEN pushes the job into outboundQueue.
// Called from inside the webhook handler.
// ============================================
function enqueueDM(ruleId, userId, commentId) {
  const key = `${ruleId}_${userId}`;

  // Set state to 'queued' before adding to queue.
  // This is our "safe record" – if the same event_id arrives again,
  // the dedup check below will see this state and block it.
  userRuleState.set(key, {
    state: 'queued',
    dm_id: null,
    commentId,
    retries: 0
  });

  outboundQueue.push({
    key,
    userId,
    ruleId,
    commentId,
    retries: 0,
    retryAfter: 0 // ready immediately
  });

  console.log(`[ENQUEUED] DM job for ${key}`);
}

// ============================================
// ENDPOINT: POST /rules
// ============================================
app.post('/rules', (req, res) => {
  const { keyword, dm_message } = req.body;

  if (!keyword || !dm_message) {
    return res.status(400).json({ error: 'Missing keyword or dm_message' });
  }

  const ruleId = `rule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Store keyword lowercased so matching is always case-insensitive.
  rules.set(ruleId, {
    keyword: keyword.toLowerCase(),
    dm_message
  });

  console.log(`[RULE] Created: ${ruleId} keyword="${keyword}"`);

  res.status(201).json({
    rule_id: ruleId,
    keyword,      // echo original casing back to caller
    dm_message
  });
});

// ============================================
// ENDPOINT: POST /webhook
// ============================================
app.post('/webhook', (req, res) => {

  // -----------------------------------------------
  // STEP 1: Verify HMAC-SHA256 signature
  //
  // PseudoGram sends:  X-PseudoGram-Signature: sha256=<hex>
  // We compute the same hash over the raw body using API_KEY.
  // timingSafeEqual prevents timing-side-channel attacks.
  // -----------------------------------------------
  const signature = req.headers['x-pseudogram-signature'];

  if (!signature) {
    return res.status(401).json({ error: 'Missing X-PseudoGram-Signature header' });
  }

  const expectedHash = crypto
    .createHmac('sha256', API_KEY)
    .update(req.rawBody || '') // rawBody captured in verify callback above
    .digest('hex');

  const expected = `sha256=${expectedHash}`;

  // Use timingSafeEqual to compare – both buffers must be same length.
  let signatureValid = false;
  try {
    signatureValid = crypto.timingSafeEqual(
      Buffer.from(signature, 'utf8'),
      Buffer.from(expected, 'utf8')
    );
  } catch (_) {
    // If lengths differ, timingSafeEqual throws. Treat as invalid.
    signatureValid = false;
  }

  if (!signatureValid) {
    console.log(`[401] Invalid signature`);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // -----------------------------------------------
  // STEP 2: Acknowledge IMMEDIATELY (< 5 seconds).
  // All processing happens asynchronously below.
  // -----------------------------------------------
  res.status(200).json({ received: true });

  // -----------------------------------------------
  // STEP 3: Process asynchronously (fire-and-forget)
  // -----------------------------------------------
  setImmediate(() => processWebhookEvent(req.body));
});

function processWebhookEvent(body) {
  const { event_id, event_type, data } = body;

  // -----------------------------------------------
  // Event deduplication:
  // If we've seen this event_id before, skip entirely.
  // An event_id is added to processedEvents only AFTER
  // the DM job is safely recorded in userRuleState.
  // -----------------------------------------------
  if (processedEvents.has(event_id)) {
    console.log(`[SKIP] Duplicate event_id=${event_id}`);
    return;
  }

  if (event_type === 'comment.created') {
    const { comment_id, text, from } = data;
    const { user_id } = from; // Always use user_id, never username

    let anyJobQueued = false;

    for (const [ruleId, rule] of rules.entries()) {
      // Case-insensitive substring match
      if (!text.toLowerCase().includes(rule.keyword)) continue;

      const key = `${ruleId}_${user_id}`;
      const existing = userRuleState.get(key);

      if (existing) {
        // This user already has a DM queued, accepted, or delivered for this rule.
        // Block the duplicate regardless of which comment triggered it.
        stats.duplicates_blocked += 1;
        console.log(`[DUPE] Blocked duplicate DM for ${key} (state=${existing.state})`);
        continue;
      }

      // No existing job – enqueue it.
      enqueueDM(ruleId, user_id, comment_id);
      anyJobQueued = true;
    }

    // Mark event as processed now that all jobs are safely recorded.
    // If no rules matched, we still mark it processed so we don't re-evaluate.
    processedEvents.add(event_id);

    if (!anyJobQueued) {
      console.log(`[NO-MATCH] event_id=${event_id} matched no rules`);
    }

  } else if (event_type === 'comment.deleted') {
    // comment.deleted has only comment_id populated.
    // Record this so any queued jobs for this comment are cancelled
    // by processOutboundQueue() before they are sent.
    //
    // If a DM was already accepted (202 returned), we cannot undo it —
    // PseudoGram provides no delete-DM API.
    const { comment_id } = data;
    cancelledComments.add(comment_id);
    console.log(`[DELETED] comment_id=${comment_id} – pending jobs will be cancelled`);
    processedEvents.add(event_id);

  } else {
    // Unknown event type – mark processed and ignore.
    console.log(`[UNKNOWN] event_type=${event_type}, event_id=${event_id}`);
    processedEvents.add(event_id);
  }
}

// ============================================
// ENDPOINT: GET /stats
//
// Dynamically calculated from live state.
// ============================================
app.get('/stats', (req, res) => {
  // queued = jobs still in outboundQueue (not yet sent)
  //        + DMs accepted by PseudoGram but not yet confirmed delivered
  let queued = outboundQueue.length;
  for (const info of userRuleState.values()) {
    if (info.state === 'accepted') queued += 1;
  }

  res.json({
    sent: stats.sent,
    failed: stats.failed,
    queued,
    duplicates_blocked: stats.duplicates_blocked
  });
});

// ============================================
// Health check (used by Render to verify service is up)
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`LinkPlease server running on port ${PORT}`);
  console.log(`API_KEY: ${API_KEY ? 'Loaded ✓' : 'NOT LOADED — set API_KEY in .env'}`);
});

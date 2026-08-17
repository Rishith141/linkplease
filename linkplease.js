require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

// ============================================
// MIDDLEWARE: Capture raw body for signature verification
// ============================================
let rawBody;
app.use((req, res, next) => {
  if (req.path === '/webhook') {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      rawBody = data;
      req.rawBody = data;
      next();
    });
  } else {
    next();
  }
});

app.use(express.json());

// Configuration
const API_BASE = 'https://pseudogram-api.onrender.com';
const API_KEY = process.env.API_KEY;
const PORT = process.env.PORT || 3000;

// In-memory storage
const rules = new Map(); // rule_id -> { keyword, dm_message }
const sentDMs = new Map(); // `${rule_id}_${user_id}` -> true (for deduplication)
const processedEvents = new Set(); // event_id -> to handle re-deliveries
const dmQueue = new Map(); // dm_id -> { status, recipient_user_id, rule_id, comment_id, retries }
const stats = {
  sent: 0,
  failed: 0,
  queued: 0,
  duplicates_blocked: 0
};

// ============================================
// HELPER: Send DM via LinkPlease API
// ============================================
async function sendDM(recipientUserId, message, commentId, ruleId) {
  try {
    const payload = {
      recipient_user_id: recipientUserId,
      message: message,
      comment_id: commentId
    };

    const response = await axios.post(
      `${API_BASE}/v1/dm/send`,
      payload,
      {
        headers: {
          'X-API-Key': API_KEY,
          'Idempotency-Key': `${ruleId}_${recipientUserId}_${commentId}`
        },
        timeout: 5000
      }
    );

    const { dm_id, status } = response.data;

    // Track in queue
    dmQueue.set(dm_id, {
      status: status,
      recipient_user_id: recipientUserId,
      rule_id: ruleId,
      comment_id: commentId,
      retries: 0,
      created_at: Date.now()
    });

    stats.queued += 1;
    return dm_id;
  } catch (error) {
    if (error.response?.status === 429) {
      // Rate limited, retry later
      console.log('Rate limited, will retry');
      stats.queued += 1;
      return null;
    } else if (error.response?.status === 500) {
      // Server error, retry later
      console.log('Server error, will retry');
      stats.queued += 1;
      return null;
    } else if (error.response?.status === 400) {
      // Bad request, don't retry
      console.log('Bad request:', error.response.data);
      stats.failed += 1;
      return null;
    } else {
      console.error('DM send error:', error.message);
      stats.failed += 1;
      return null;
    }
  }
}

// ============================================
// HELPER: Check DM status and update
// ============================================
async function checkDMStatus(dmId) {
  try {
    const response = await axios.get(
      `${API_BASE}/v1/dm/${dmId}`,
      {
        headers: {
          'X-API-Key': API_KEY
        }
      }
    );

    const { status } = response.data;
    const dmInfo = dmQueue.get(dmId);

    if (status === 'delivered') {
      if (dmInfo?.status === 'queued') {
        stats.queued -= 1;
        stats.sent += 1;
      }
      dmInfo.status = 'delivered';
      dmQueue.set(dmId, dmInfo);
    } else if (status === 'failed') {
      if (dmInfo?.status === 'queued') {
        stats.queued -= 1;
        stats.failed += 1;
      }
      dmInfo.status = 'failed';
      dmQueue.set(dmId, dmInfo);
    }
    // if 'queued', leave as is
  } catch (error) {
    console.error('Error checking DM status:', error.message);
  }
}

// ============================================
// BACKGROUND: Retry failed DMs every 5 seconds
// ============================================
setInterval(async () => {
  for (const [dmId, dmInfo] of dmQueue.entries()) {
    if (dmInfo.status === 'queued' && dmInfo.retries < 3) {
      // Check status periodically
      await checkDMStatus(dmId);
    }
  }
}, 5000);

// ============================================
// ENDPOINT: POST /rules
// ============================================
app.post('/rules', (req, res) => {
  const { keyword, dm_message } = req.body;

  if (!keyword || !dm_message) {
    return res.status(400).json({ error: 'Missing keyword or dm_message' });
  }

  const ruleId = `rule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  rules.set(ruleId, {
    keyword: keyword.toLowerCase(),
    dm_message: dm_message
  });

  res.status(201).json({
    rule_id: ruleId,
    keyword: keyword,
    dm_message: dm_message
  });
});

// ============================================
// ENDPOINT: POST /webhook
// ============================================
app.post('/webhook', async (req, res) => {
  // ============================================
  // PART B: Verify webhook signature
  // ============================================
  const signature = req.headers['x-pseudogram-signature'];
  if (!signature) {
    return res.status(401).json({ error: 'Missing X-PseudoGram-Signature header' });
  }

  // Verify HMAC-SHA256
  const expectedHash = crypto
    .createHmac('sha256', API_KEY)
    .update(req.rawBody || JSON.stringify(req.body))
    .digest('hex');

  const expectedSignature = `sha256=${expectedHash}`;

  if (signature !== expectedSignature) {
    console.log(`Signature mismatch. Expected: ${expectedSignature}, Got: ${signature}`);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Signature valid, proceed
  // Return 200 immediately (don't block)
  res.status(200).json({ received: true });

  // Process asynchronously
  (async () => {
    try {
      const { event_id, event_type, data } = req.body;

      // Ignore if already processed (handle re-deliveries)
      if (processedEvents.has(event_id)) {
        console.log(`Event ${event_id} already processed, skipping`);
        return;
      }

      processedEvents.add(event_id);

      // Handle different event types
      if (event_type === 'comment.created') {
        const { comment_id, text, from } = data;
        const { user_id } = from;

        // Match against all rules
        for (const [ruleId, rule] of rules.entries()) {
          if (text.toLowerCase().includes(rule.keyword)) {
            // Check deduplication
            const dedupKey = `${ruleId}_${user_id}`;

            if (!sentDMs.has(dedupKey)) {
              // Not sent yet, send DM
              sentDMs.set(dedupKey, true);
              await sendDM(user_id, rule.dm_message, comment_id, ruleId);
            } else {
              // Already sent, block duplicate
              stats.duplicates_blocked += 1;
            }
          }
        }
      } else if (event_type === 'comment.deleted') {
        // Handle deleted comments (optional for Part A)
        console.log(`Comment deleted: ${data.comment_id}`);
      }
    } catch (error) {
      console.error('Webhook processing error:', error.message);
    }
  })();
});

// ============================================
// ENDPOINT: GET /stats
// ============================================
app.get('/stats', (req, res) => {
  // Recalculate queued from dmQueue
  let activeQueued = 0;
  for (const dmInfo of dmQueue.values()) {
    if (dmInfo.status === 'queued') {
      activeQueued += 1;
    }
  }

  res.json({
    sent: stats.sent,
    failed: stats.failed,
    queued: activeQueued,
    duplicates_blocked: stats.duplicates_blocked
  });
});

// ============================================
// Health check endpoint (for Render)
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`LinkPlease server running on port ${PORT}`);
  console.log(`API Key: ${API_KEY ? 'Loaded' : 'NOT LOADED - set API_KEY in .env'}`);
});

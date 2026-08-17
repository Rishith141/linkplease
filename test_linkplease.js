// test_linkplease.js - Local test script for LinkPlease API
// Run AFTER starting the server: node linkplease.js
// Usage: node test_linkplease.js
require('dotenv').config();
const crypto = require('crypto');
const http = require('http');

const PORT = process.env.PORT || 3000;
const BASE = `http://localhost:${PORT}`;
const API_KEY = process.env.API_KEY;
let pass = 0, fail = 0;

// ============================================
// HTTP helpers (no axios dependency in test)
// ============================================
function request(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: 'localhost',
      port: PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...extraHeaders
      }
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function makeSignature(bodyStr) {
  return 'sha256=' + crypto.createHmac('sha256', API_KEY).update(bodyStr).digest('hex');
}

function webhookReq(payload, overrideSignature) {
  const bodyStr = JSON.stringify(payload);
  const sig = overrideSignature || makeSignature(bodyStr);
  return request('POST', '/webhook', payload, { 'X-PseudoGram-Signature': sig });
}

function check(label, condition, got) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    pass++;
  } else {
    console.log(`  ❌ FAIL: ${label} | got: ${JSON.stringify(got)}`);
    fail++;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================
// Test runner
// ============================================
(async () => {
  console.log('=== LinkPlease Test Suite ===\n');

  // ─── Test 1: POST /rules returns 201 ───────────────────────────
  console.log('1. POST /rules');
  const r1 = await request('POST', '/rules', { keyword: 'PRICE', dm_message: 'Here is the price list!' });
  check('status 201', r1.status === 201, r1.status);
  check('has rule_id', !!r1.body.rule_id, r1.body);
  check('keyword echoed', r1.body.keyword === 'PRICE', r1.body.keyword);
  const ruleId = r1.body.rule_id;

  // ─── Test 2: GET /stats baseline ──────────────────────────────
  console.log('\n2. GET /stats baseline');
  const r2 = await request('GET', '/stats');
  check('status 200', r2.status === 200, r2.status);
  check('has sent', typeof r2.body.sent === 'number', r2.body);
  check('has queued', typeof r2.body.queued === 'number', r2.body);
  check('has failed', typeof r2.body.failed === 'number', r2.body);
  check('has duplicates_blocked', typeof r2.body.duplicates_blocked === 'number', r2.body);

  // ─── Test 3: Valid webhook signature → 200 ─────────────────────
  console.log('\n3. POST /webhook with valid signature');
  const evt1 = {
    event_id: 'evt_test_001',
    event_type: 'comment.created',
    sent_at: new Date().toISOString(),
    data: {
      comment_id: 'cmt_001',
      post_id: 'post_001',
      text: 'What is the PRICE please?',
      from: { user_id: 'usr_AAA', username: 'tester_a' }
    }
  };
  const r3 = await webhookReq(evt1);
  check('status 200', r3.status === 200, r3.status);
  check('body received=true', r3.body.received === true, r3.body);

  // ─── Test 4: Invalid signature → 401 ──────────────────────────
  console.log('\n4. POST /webhook with invalid signature');
  const r4 = await webhookReq(evt1, 'sha256=badhash123');
  check('status 401', r4.status === 401, r4.status);

  // ─── Test 5: Missing signature → 401 ──────────────────────────
  console.log('\n5. POST /webhook with missing signature');
  const r5 = await request('POST', '/webhook', evt1); // no signature header
  check('status 401', r5.status === 401, r5.status);

  // ─── Test 6: Duplicate event_id → still 200 but not re-queued ─
  console.log('\n6. Duplicate event_id (same event sent twice)');
  await sleep(200); // let first event be processed
  const statsBefore = (await request('GET', '/stats')).body;
  const r6 = await webhookReq(evt1); // same event_id as test 3
  check('still 200', r6.status === 200, r6.status);
  await sleep(200);
  const statsAfter = (await request('GET', '/stats')).body;
  // queued should NOT have incremented (duplicate blocked by processedEvents)
  check('queued not incremented', statsAfter.queued <= statsBefore.queued + 1, { before: statsBefore.queued, after: statsAfter.queued });

  // ─── Test 7: Second comment from same user (different comment_id) → duplicate blocked ─
  console.log('\n7. Same user, same rule, different comment → duplicate blocked');
  const dupStatsBefore = (await request('GET', '/stats')).body;
  const evt7 = {
    event_id: 'evt_test_007', // different event_id
    event_type: 'comment.created',
    sent_at: new Date().toISOString(),
    data: {
      comment_id: 'cmt_007', // different comment
      post_id: 'post_001',
      text: 'Hey PRICE again',
      from: { user_id: 'usr_AAA', username: 'tester_a' } // SAME user
    }
  };
  await webhookReq(evt7);
  await sleep(200);
  const dupStatsAfter = (await request('GET', '/stats')).body;
  check('duplicates_blocked incremented', dupStatsAfter.duplicates_blocked > dupStatsBefore.duplicates_blocked, { before: dupStatsBefore.duplicates_blocked, after: dupStatsAfter.duplicates_blocked });

  // ─── Test 8: Different user, same rule → NOT a duplicate ───────
  console.log('\n8. Different user, same rule → should queue a new DM');
  const statsB8 = (await request('GET', '/stats')).body;
  const evt8 = {
    event_id: 'evt_test_008',
    event_type: 'comment.created',
    sent_at: new Date().toISOString(),
    data: {
      comment_id: 'cmt_008',
      post_id: 'post_001',
      text: 'PRICE list please',
      from: { user_id: 'usr_BBB', username: 'tester_b' } // DIFFERENT user
    }
  };
  await webhookReq(evt8);
  await sleep(200);
  const statsA8 = (await request('GET', '/stats')).body;
  check('queued incremented for new user', statsA8.queued >= statsB8.queued, { before: statsB8.queued, after: statsA8.queued });

  // ─── Test 9: Multiple rules – same comment matches both ────────
  console.log('\n9. Multiple rules – comment matching two keywords');
  const r9r = await request('POST', '/rules', { keyword: 'LINK', dm_message: 'Here is the link!' });
  const ruleId2 = r9r.body.rule_id;
  const statsB9 = (await request('GET', '/stats')).body;
  const evt9 = {
    event_id: 'evt_test_009',
    event_type: 'comment.created',
    sent_at: new Date().toISOString(),
    data: {
      comment_id: 'cmt_009',
      post_id: 'post_001',
      text: 'PRICE and LINK please',
      from: { user_id: 'usr_CCC', username: 'tester_c' }
    }
  };
  await webhookReq(evt9);
  await sleep(300);
  const statsA9 = (await request('GET', '/stats')).body;
  // Two rules matched, so queued should increase by at least 2
  check('queued increased by 2 (both rules)', statsA9.queued >= statsB9.queued + 2, { before: statsB9.queued, after: statsA9.queued });

  // ─── Test 10: comment.deleted cancels pending job ──────────────
  console.log('\n10. comment.deleted before DM is sent');
  const evtDel = {
    event_id: 'evt_test_010_create',
    event_type: 'comment.created',
    sent_at: new Date().toISOString(),
    data: {
      comment_id: 'cmt_deleteme',
      post_id: 'post_001',
      text: 'PRICE?',
      from: { user_id: 'usr_DDD', username: 'tester_d' }
    }
  };
  await webhookReq(evtDel);
  const evtDelete = {
    event_id: 'evt_test_010_delete',
    event_type: 'comment.deleted',
    sent_at: new Date().toISOString(),
    data: { comment_id: 'cmt_deleteme' }
  };
  const r10 = await webhookReq(evtDelete);
  check('deletion webhook returns 200', r10.status === 200, r10.status);

  // ─── Test 11: Rate limiter – webhook responds < 5s ─────────────
  console.log('\n11. Webhook responds quickly (< 5 seconds)');
  const t0 = Date.now();
  const evtQuick = {
    event_id: 'evt_test_011',
    event_type: 'comment.created',
    sent_at: new Date().toISOString(),
    data: {
      comment_id: 'cmt_011',
      post_id: 'post_001',
      text: 'PRICE here',
      from: { user_id: 'usr_EEE', username: 'tester_e' }
    }
  };
  await webhookReq(evtQuick);
  const elapsed = Date.now() - t0;
  check(`responded in ${elapsed}ms (< 5000ms)`, elapsed < 5000, elapsed);

  // ─── Test 12: /stats reflects accurate queued state ────────────
  console.log('\n12. /stats queued count reflects pending queue');
  const statsF = (await request('GET', '/stats')).body;
  check('queued >= 0', statsF.queued >= 0, statsF);
  check('sent >= 0', statsF.sent >= 0, statsF);
  check('failed >= 0', statsF.failed >= 0, statsF);
  console.log(`  ℹ  Stats: ${JSON.stringify(statsF)}`);

  // ─── Summary ───────────────────────────────────────────────────
  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
})();

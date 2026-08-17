# Deployment Guide (Render.com)

## What's Implemented

- **Part A – Core Reliability:**
  - Rule matching (case-insensitive substring match)
  - HMAC-SHA256 signature verification on raw request body (`X-PseudoGram-Signature`)
  - Webhook event deduplication (`event_id`)
  - User + rule deduplication (`user_id`, logical `rule_id + user_id` operation)
  - Global outbound DM queue & rate limiter (max 10 requests per rolling 60s window)
  - Retry state machine for 500 errors and 429 rate limits (respects `Retry-After`)
  - Delivery reconciliation polling loop (`GET /v1/dm/{dm_id}`)
  - Cancellation of unsent DM jobs upon receiving `comment.deleted`
  - Accurate dynamic `/stats` calculation

- **Part B – Security:**
  - `express.json({ verify })` captures raw body buffer before JSON parsing
  - Rejects forged or missing signature requests with HTTP 401
  - Timing-safe signature comparison via `crypto.timingSafeEqual`

---

## Folder Structure

```
linkplease/
  ├── linkplease.js          # Core Express application server
  ├── test_linkplease.js     # Comprehensive local test suite (22 tests)
  ├── package.json           # Dependencies (express, axios, dotenv)
  ├── FAILURES.md            # Honest documentation of edge cases & limitations
  ├── DEPLOY.md              # Deployment guide (this document)
  ├── .env.example           # Template environment variable placeholders
  ├── .gitignore             # Ignores .env and node_modules/
  └── .env                   # Local env variables (NOT committed to Git)
```

---

## Step 1: Environment Setup

Create `.env` locally (never commit this file):

```ini
API_KEY=your_pseudogram_api_key_here
PORT=3000
```

Verify `.gitignore` contains:
```
node_modules/
.env
.env.local
```

---

## Step 2: Local Testing

Start the server:
```bash
npm start
# Server running on port 3000
```

In a second terminal, execute the local test suite:
```bash
node test_linkplease.js
```

All 22 test scenarios should report `✅ PASS`.

---

## Step 3: Deploying to Render.com

1. Push your changes to GitHub:
   ```bash
   git add linkplease.js FAILURES.md DEPLOY.md .env.example test_linkplease.js
   git commit -m "Implement LinkPlease backend reliability, rate limiter, and test suite"
   git push origin main
   ```

2. Open the Render Dashboard → Select your Web Service.
3. In **Environment Variables**:
   - Add `API_KEY`: `<your_real_pseudogram_api_key>`
   - `PORT`: set automatically by Render (code defaults to `process.env.PORT || 3000`)
4. Trigger **Manual Deploy** → **Deploy latest commit**.

---

## Step 4: Verification After Deployment

Verify your deployed URL health and stats:
```bash
curl https://<your-app-name>.onrender.com/health
curl https://<your-app-name>.onrender.com/stats
```

Test with PseudoGram Simulator (optional):
```bash
curl -X POST https://pseudogram-api.onrender.com/v1/simulate/start \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "webhook_url": "https://<your-app-name>.onrender.com/webhook",
    "count": 50,
    "duration_seconds": 15
  }'
```

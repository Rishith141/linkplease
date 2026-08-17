# Deployment Guide (Render.com)

## What's Implemented

- **Part A:** Rule matching, webhook deduplication, DM sending, stats tracking
- **Part B:** Webhook signature verification (HMAC-SHA256 validation)

---

## Step 1: Get Your API Key

1. Go to https://pseudogram-api.onrender.com
2. POST to `/v1/apply` with your details:
```bash
curl -X POST https://pseudogram-api.onrender.com/v1/apply \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Your Name",
    "email": "your@email.com",
    "phone": "+91...",
    "whatsapp": "+91...",
    "linkedin_url": "https://linkedin.com/in/you"
  }'
```

3. Once approved, POST to `/v1/keygen`:
```bash
curl -X POST https://pseudogram-api.onrender.com/v1/keygen \
  -H "Content-Type: application/json" \
  -d '{"email": "your@email.com"}'
```

Save the `api_key` you get back.

## Step 2: Setup Locally (Test First)

```bash
# Clone repo or create folder
mkdir linkplease && cd linkplease

# Copy the files I gave you:
# - linkplease.js
# - package.json
# - .env.example

# Create .env file
cp .env.example .env
# Edit .env, add your API_KEY

# Install dependencies
npm install

# Start server
npm start
# Should see: "LinkPlease server running on port 3000"

# Test locally (in another terminal)
curl -X POST http://localhost:3000/rules \
  -H "Content-Type: application/json" \
  -d '{"keyword": "PRICE", "dm_message": "Here is our price list"}'

# Should return: { "rule_id": "rule_...", "keyword": "PRICE", ... }

curl http://localhost:3000/stats
# Should return: { "sent": 0, "failed": 0, "queued": 0, "duplicates_blocked": 0 }
```

## Step 3: Push to GitHub

```bash
git init
git add .
git commit -m "LinkPlease backend - Part A+B"
git remote add origin https://github.com/YOUR_USERNAME/linkplease.git
git push -u origin main

# Make sure repo is PUBLIC
```

## Step 4: Deploy to Render

1. Go to https://render.com
2. Sign up with GitHub
3. Click "New +" → "Web Service"
4. Connect your GitHub repo (linkplease)
5. Fill in:
   - **Name:** linkplease
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
6. Click "Advanced" and add Environment Variable:
   - **Key:** API_KEY
   - **Value:** (paste your LinkPlease API key)
7. Click "Create Web Service"

Wait 2-3 minutes. You'll get a URL like `https://linkplease-xxx.onrender.com`

## Step 5: Test Deployed Version

```bash
# Test your rules endpoint
curl -X POST https://linkplease-xxx.onrender.com/rules \
  -H "Content-Type: application/json" \
  -d '{"keyword": "PRICE", "dm_message": "Check our pricing: https://..."}'

# Test stats
curl https://linkplease-xxx.onrender.com/stats
```

## Step 6: Test with LinkPlease Simulator

```bash
# Get run_id
curl -X POST https://pseudogram-api.onrender.com/v1/simulate/start \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "webhook_url": "https://linkplease-xxx.onrender.com/webhook",
    "count": 50,
    "duration_seconds": 10
  }'

# Wait for simulation to finish, then check truth
curl https://pseudogram-api.onrender.com/v1/simulate/RUN_ID/truth \
  -H "X-API-Key: YOUR_API_KEY"

# Compare with your /stats
curl https://linkplease-xxx.onrender.com/stats
```

## Step 7: Submit

POST to https://pseudogram-api.onrender.com/v1/submit:

```bash
curl -X POST https://pseudogram-api.onrender.com/v1/submit \
  -H "Content-Type: application/json" \
  -d '{
    "email": "your@email.com",
    "github_repo": "https://github.com/YOUR_USERNAME/linkplease",
    "working_url": "https://linkplease-xxx.onrender.com",
    "loom_url": "https://loom.com/share/...",
    "parts_completed": "A+B",
    "start_date": "2026-08-16"
  }'
```

---

## Troubleshooting

**Stats don't match truth:**
- Make sure you're checking queued correctly (recalculated from dmQueue each time)
- Run simulator with smaller count (10 not 500) to debug

**Getting 429 rate limited:**
- Reduce comment count in simulator
- Space out tests by 60+ seconds

**Webhook not receiving events:**
- Check Render logs: Dashboard → Select app → Logs
- Make sure working_url is correct and live

**API key not working:**
- Confirm you got 202 Accepted on keygen
- Try a fresh application if stuck on 403

**Signature verification failing:**
- Ensure your API_KEY is set correctly in Render env vars
- Check logs for "Signature mismatch" errors

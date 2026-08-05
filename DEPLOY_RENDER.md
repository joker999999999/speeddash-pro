# Deploy To Render (3 minutes)

This file is a ready checklist for publishing SpeedDash Pro to the Internet.

## 1) Prepare repository

1. Push this project to GitHub.
2. Ensure these files are in the repo root:
   - render.yaml
   - server.js
   - package.json
   - index.html

## 2) Create Render service

1. Open Render dashboard.
2. Click New -> Web Service.
3. Connect your GitHub repo.
4. Render should detect render.yaml automatically.

Expected config:
- Runtime: node
- Build command: npm install
- Start command: npm run web
- Health check path: /health

## 3) Add environment variables in Render

Set these exact keys:

- NODE_ENV=production
- PORT=10000
- APP_BASE_URL=https://www.speeddash-pro.com
- ALLOWED_ORIGINS=https://www.speeddash-pro.com,https://speeddash-pro.com

For Stripe (real card payments):
- STRIPE_SECRET_KEY=sk_live_or_test_xxx
- STRIPE_PUBLISHABLE_KEY=pk_live_or_test_xxx
- STRIPE_SUCCESS_URL=https://www.speeddash-pro.com/index.html?payment=success
- STRIPE_CANCEL_URL=https://www.speeddash-pro.com/index.html?payment=cancel

For direct payment links (SBP/MIR/Crypto):
- PAYMENT_LINK_SBP=https://your-provider/sbp?amount={amount}&currency={currency}
- PAYMENT_LINK_MIR=https://your-provider/mir?amount={amount}&currency={currency}
- PAYMENT_LINK_CRYPTO=https://your-provider/crypto?amount={amount}&currency={currency}

If you have a custom domain, replace APP_BASE_URL, ALLOWED_ORIGINS, STRIPE_SUCCESS_URL, STRIPE_CANCEL_URL with your custom domain.

## 4) Deploy and verify

1. Click Deploy.
2. Wait until status becomes Live.
3. Open:
   - https://YOUR-RENDER-DOMAIN.onrender.com/health
   - Expected response: {"ok":true}
4. If the service shows 503, open the Render logs and confirm PORT=10000 is set.

## 5) Functional checks

1. Open the main page and run one speed test.
2. Click Share and verify native share or copy fallback.
3. Install as PWA from browser prompt.
4. Open donation modal:
   - SBP/MIR/Crypto should open direct links.
   - Visa/MasterCard/Card should redirect to Stripe Checkout.

## 6) Common issues

1. Payment session error:
   - Check STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY.
2. Redirect domain mismatch:
   - Verify APP_BASE_URL and ALLOWED_ORIGINS match the real public domain exactly.
3. CORS or wrong callback URLs:
   - Verify STRIPE_SUCCESS_URL and STRIPE_CANCEL_URL.

## 7) Security notes

1. Never put STRIPE_SECRET_KEY in frontend files.
2. Keep secrets only in Render Environment variables.
3. Rotate test keys before production launch.

## 8) Connect your custom domain

1. In Render service settings, open Custom Domains.
2. Add both domains:
   - `speeddash-pro.com`
   - `www.speeddash-pro.com`
3. In your DNS provider:
   - Create a CNAME record: `www` -> your Render hostname (`your-service.onrender.com`).
   - Create an ALIAS/ANAME (or A record if your DNS provider requires it) for root domain `@` -> Render target.
4. Wait for DNS propagation, then verify both domains open your app.
5. Update Render env vars to match your domain exactly:
   - `APP_BASE_URL=https://www.your-domain.com`
   - `ALLOWED_ORIGINS=https://www.your-domain.com,https://your-domain.com`
   - `STRIPE_SUCCESS_URL=https://www.your-domain.com/index.html?payment=success`
   - `STRIPE_CANCEL_URL=https://www.your-domain.com/index.html?payment=cancel`
6. Enable HTTPS redirect to force `https://` and one canonical host (`www` or non-`www`).

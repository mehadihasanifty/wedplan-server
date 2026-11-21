# WedPlan API Server

Express.js API for the WedPlan wedding planning platform. It uses MongoDB and validates Better Auth sessions through short-lived, signed JWT access cookies.

## Features

- Role-protected service, booking, profile, user administration, service moderation, and transaction APIs.
- Ownership checks for vendor listings and booking requests; public service results include only approved and active listings.
- Advanced service search, category/location filters, pagination, and ascending/descending price sorting.
- JWT signature, issuer, audience, expiry, and revocation checks on protected routes.
- Stripe Checkout, verified webhook processing, subscription synchronization, and read-only admin transaction records.
- Startup migration for legacy WedPlan fields plus MongoDB indexes for service, booking, transaction, and booking-slot access.

## Technology

Node.js, Express 5, MongoDB, Better Auth, JSON Web Tokens, and Stripe. Image uploads are handled by the Next.js client.

## Repositories and deployment

- Client: [github.com/mehadihasanifty/wedplan-client](https://github.com/mehadihasanifty/wedplan-client)
- Server: [github.com/mehadihasanifty/wedplan-server](https://github.com/mehadihasanifty/wedplan-server)
- Live website: Not deployed yet. Add the deployed URL here before submission.

## Run locally

1. Install **Node.js 20 or newer** and create a MongoDB Atlas cluster (or run MongoDB locally).
2. Install dependencies:

   ```bash
   npm install
   ```

3. Create your environment file:

   ```bash
   cp .env.example .env
   ```

   Then fill in `MONGODB_URL`, `BETTER_AUTH_SECRET`, and `JWT_SECRET`. Generate the two secrets with:

   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

   Use the **same** `MONGODB_URL`, `BETTER_AUTH_SECRET`, and `BETTER_AUTH_URL` as the WedPlan client.

4. Start the API:

   ```bash
   npm run dev
   ```

The API listens on `http://localhost:5000` by default. Verify it with:

```bash
curl http://localhost:5000/api/health
curl http://localhost:5000/user
```

`GET /user` is a **development-only** helper that lists the users in the `user` collection (passwords are stored separately by Better Auth). It is automatically disabled when `NODE_ENV=production`.

## Deploy the API to Vercel

Keep the Vercel project Root Directory set to this server repository root. The root `vercel.json` pins the Express framework and clears any dashboard Next.js build-command override; Vercel detects `index.js` as the Express entry point. Do not set the project Framework Preset to Next.js or a custom `next build` command. Add the server environment variables from `.env.example` in Vercel Project Settings before redeploying.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | API port; defaults to `5000`. |
| `CLIENT_URL` | Allowed client origin(s), comma-separated when needed; also used for Stripe redirects. |
| `MONGODB_URL` | MongoDB connection string. Keep this server-side and point client/server at the same database. |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | Must match the client Better Auth configuration. |
| `JWT_SECRET` | Random server-only signing secret of at least 32 bytes. |
| `JWT_ACCESS_TTL` | JWT lifetime, for example `15m`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional server-side OAuth credentials. |
| `STRIPE_SECRET_KEY` | Stripe Test Mode secret key, server-side only. |
| `STRIPE_PREMIUM_PRICE_ID` | Stripe recurring Premium price ID. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for verified Stripe webhooks. |

## API routes

- `GET /api/services` — approved and active listings; vendors can request their own records with `vendorId`.
- `POST /api/services`, `PATCH /api/services/:id`, `DELETE /api/services/:id` — vendor service management.
- `GET /api/bookings`, `POST /api/bookings`, `PATCH /api/bookings/:id` — customer booking workflow.
- `GET /api/vendor/bookings`, `PATCH /api/vendor/bookings/:id` — vendor booking queue and decisions.
- `PATCH /api/profile` — customer/vendor profile edits; role and subscription fields are rejected.
- `/api/admin/*` — admin overview, user moderation, service moderation, and read-only transactions.
- `/api/payments/*` — subscription checkout, portal, status, and verified Stripe webhook handling.
- `POST /api/auth/token` — exchange a Better Auth session for the HttpOnly JWT cookie used by this API.
- `GET /user` — development-only list of users for local inspection; disabled in production.

## Stripe Test Mode

Create an active recurring Premium Price in Stripe Test Mode and copy its `price_...` ID to `STRIPE_PREMIUM_PRICE_ID`. Put the `sk_test_...` key only in the server `.env`; the app intentionally rejects live keys in this assignment flow. For local webhook testing, run `stripe listen --forward-to localhost:5000/api/payments/webhook`, then copy the CLI's `whsec_...` value into `STRIPE_WEBHOOK_SECRET` and restart the API. In Stripe Dashboard, register `https://<server-host>/api/payments/webhook` for deployment (locally use the CLI forwarder) and subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `invoice.paid`, `invoice.payment_succeeded`, and `invoice.payment_failed`. Enable Stripe Customer Portal in Test Mode for subscription management.

Only vendors can create Premium Checkout Sessions. Transactions begin as `pending`; Premium access is updated from Stripe-signed webhook events, never from the browser return URL. The customer booking workflow in Assignment 9 does not charge customers; Stripe is used for vendor Premium subscriptions only.

## Security and production setup

Never commit `.env` or credentials. Configure environment variables through the deployment provider. Allow the deployed client origin in `CLIENT_URL`, use HTTPS in production, set the client API URL to this server, and configure the Stripe production webhook URL/secret. Test role access and page reloads after deployment.

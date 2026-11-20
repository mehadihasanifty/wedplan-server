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

Node.js, Express 5, MongoDB, Better Auth, JSON Web Tokens, Stripe, and ImgBB (uploads are proxied by the Next.js client server route).

## Repositories and deployment

- Client: [github.com/mehadihasanifty/wedplan-client](https://github.com/mehadihasanifty/wedplan-client)
- Server: [github.com/mehadihasanifty/wedplan-server](https://github.com/mehadihasanifty/wedplan-server)
- Live website: Not deployed yet. Add the deployed URL here before submission.

## Run locally

1. Install Node.js and MongoDB Atlas or a local MongoDB instance.
2. Copy `.env.example` to `.env` and configure the variables below. Use the same `MONGODB_URL`, `BETTER_AUTH_SECRET`, and `BETTER_AUTH_URL` as the client.
3. Run:

   ```bash
   npm install
   npm run dev
   ```

The API listens on `http://localhost:5000` by default. Health check: `GET /api/health`.

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

## Stripe Test Mode

Configure the webhook endpoint as `https://<server-host>/api/payments/webhook` (locally: `http://localhost:5000/api/payments/webhook`) and provide its signing secret as `STRIPE_WEBHOOK_SECRET`. Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `invoice.paid`, `invoice.payment_succeeded`, and `invoice.payment_failed`. Enable Stripe Customer Portal in Test Mode for subscription management.

## Security and production setup

Never commit `.env` or credentials. Configure environment variables through the deployment provider. Allow the deployed client origin in `CLIENT_URL`, use HTTPS in production, set the client API URL to this server, and configure the Stripe production webhook URL/secret. Test role access and page reloads after deployment.

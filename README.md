# WedPlan API server

Express API for the WedPlan Next.js client. The server uses the same MongoDB database and Better Auth secret as the client so it can verify the existing login session.

## Local setup

1. `MONGODB_URL` is configured in both local `.env` files. Keep the client and server values pointed at the same database.
2. Keep `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` synchronized with the client environment.
3. `JWT_SECRET` must be a server-only random value of at least 32 bytes. `JWT_ACCESS_TTL` defaults to `15m`.
4. `NEXT_PUBLIC_API_URL=http://localhost:5000/api` is set in the client `.env`; restart Next.js after environment changes.
5. Start this API from `F:\Projects\wedplan-server` with `npm run dev`; start the client from `F:\Projects\wedplan-client` with `npm run dev`.

`GET /api/health` reports API health. In Stripe Test Mode, configure the server-only `STRIPE_SECRET_KEY` (`sk_test_…`), `STRIPE_PREMIUM_PRICE_ID` (`price_…`), and `STRIPE_WEBHOOK_SECRET` (`whsec_…`). For local webhook delivery, forward Stripe events to `http://localhost:5000/api/payments/webhook` and copy the signing secret from Stripe CLI into `.env`. Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `invoice.paid`, `invoice.payment_succeeded`, and `invoice.payment_failed`. Enable the Stripe Customer Portal in Test Mode to let vendors manage or cancel subscriptions.

## API routes

- `GET /api/services` — approved and active public listings; vendors may request their own listings with a `vendorId` query.
- `POST /api/services`, `PATCH /api/services/:id`, `DELETE /api/services/:id` — vendor-owned service management.
- `GET /api/bookings`, `POST /api/bookings`, `PATCH /api/bookings/:id` — customer booking list, creation, and pending cancellation.
- `GET /api/vendor/bookings`, `PATCH /api/vendor/bookings/:id` — vendor-owned booking requests and pending accept/reject.
- `PATCH /api/profile` — authenticated customer/vendor editable profile fields; role and subscription fields are rejected.
- `/api/admin/*` — admin overview, users, service moderation, and read-only transactions.
- `POST /api/payments/create-checkout-session` — vendor Premium checkout.

After Better Auth login, the client exchanges its session cookie at `POST /api/auth/token`. The API validates that session and sets a short-lived JWT in an HttpOnly, SameSite cookie; the raw token is never placed in browser storage or returned in JSON. Client API calls send credentials, and a `401` triggers a token reissue from the still-valid Better Auth session. Protected Express routes verify the JWT signature and expiry, then reload the user and current role/block state from MongoDB. Clients cannot set customer/vendor ownership or mark payment transactions successful.



# WedPlan API server

Express API for the WedPlan Next.js client. The server uses the same MongoDB database and Better Auth secret as the client so it can verify the existing login session.

## Local setup

1. `MONGODB_URL` is set in both local `.env` files from the server example. It points to the local MongoDB database; replace it in both files if your database uses a different URI. A MongoDB service must be running at that address.
2. Keep `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` synchronized with the client environment.
3. `NEXT_PUBLIC_API_URL=http://localhost:5000/api` is set in the client `.env`; restart Next.js after environment changes.
4. Start this API from `F:\Projects\wedplan-server` with `npm run dev`; start the client from `F:\Projects\wedplan-client` with `npm run dev`.

`GET /api/health` reports API health. Configure `STRIPE_SECRET_KEY`, `STRIPE_PREMIUM_PRICE_ID`, and `STRIPE_WEBHOOK_SECRET` to enable Premium checkout and verified payment updates. The webhook endpoint is `POST /api/payments/webhook`.

## API routes

- `GET /api/services` — approved and active public listings; vendors may request their own listings with a `vendorId` query.
- `POST /api/services`, `PATCH /api/services/:id`, `DELETE /api/services/:id` — vendor-owned service management.
- `GET /api/bookings`, `POST /api/bookings`, `PATCH /api/bookings/:id` — customer booking list, creation, and pending cancellation.
- `GET /api/vendor/bookings`, `PATCH /api/vendor/bookings/:id` — vendor-owned booking requests and pending accept/reject.
- `/api/admin/*` — admin overview, users, service moderation, and read-only transactions.
- `POST /api/payments/create-checkout-session` — vendor Premium checkout.

Protected routes derive the user and role from the Better Auth session cookie. Clients cannot set customer/vendor ownership or mark payment transactions successful.



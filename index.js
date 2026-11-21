/**
 * WedPlan API server
 *
 * This file contains the entire Express application: configuration, database
 * setup, authentication, middleware, route handlers, and startup logic. It is
 * organized in the order the server boots so it can be read top to bottom.
 */

// ============================================================================
// Imports
// ============================================================================

import "dotenv/config";
import express, { Router } from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import Stripe from "stripe";
import { MongoClient, ObjectId } from "mongodb";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { mongodbAdapter } from "@better-auth/mongo-adapter";

// ============================================================================
// Environment and constants
// ============================================================================

const port = Number(process.env.PORT) || 5000;

const mongoUri = process.env.MONGODB_URL?.trim();
if (!mongoUri) throw new Error("MONGODB_URL must be set.");

const jwtSecret = process.env.JWT_SECRET?.trim();
if (!jwtSecret || Buffer.byteLength(jwtSecret) < 32) {
  throw new Error("JWT_SECRET must be set on the server and contain at least 32 bytes.");
}

const tokenCookie = "wedplan_access";
const issuer = "wedplan-server";
const audience = "wedplan-api";

// ============================================================================
// Shared helpers
// ============================================================================

function getAllowedClientOrigins() {
  const configured = [
    process.env.CLIENT_URL,
    process.env.BETTER_AUTH_URL,
    process.env.CLIENT_ORIGINS,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((value) => {
      try {
        return new URL(value.trim()).origin;
      } catch {
        return "";
      }
    })
    .filter(Boolean);

  return [...new Set(configured)];
}

function idOptions(id) {
  const value = String(id ?? "");
  const options = [value];
  if (ObjectId.isValid(value) && new ObjectId(value).toHexString() === value.toLowerCase()) options.push(new ObjectId(value));
  return options;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const asyncRoute = (handler) => (request, response, next) =>
  Promise.resolve(handler(request, response, next)).catch(next);

function isAllowedImageUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function fromMinorUnits(amount, currency) {
  const code = String(currency || "USD").toUpperCase();
  const digits = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
  return Number((Number(amount || 0) / (10 ** digits)).toFixed(digits));
}

// ============================================================================
// Database
// ============================================================================

const globalMongo = globalThis;
const mongoClient = globalMongo.wedPlanMongoClient ?? new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
if (process.env.NODE_ENV !== "production") globalMongo.wedPlanMongoClient = mongoClient;

// Both Next.js and Express store Better Auth users/sessions in this database.
const authDb = mongoClient.db("wedding_planning_platform");
const db = mongoClient.db("wedding_planning_platform");

async function connectDatabase() {
  await mongoClient.connect();
  await authDb.command({ ping: 1 });
  await db.command({ ping: 1 });

  await migrateLegacyBusinessFields();

  await Promise.all([
    db.collection("services").createIndex({ vendorId: 1 }, { name: "services_vendor_reference" }),
    db.collection("bookings").createIndex({ customerId: 1, createdAt: -1 }, { name: "bookings_customer_created" }),
    db.collection("bookings").createIndex({ vendorId: 1, createdAt: -1 }, { name: "bookings_vendor_created" }),
    db.collection("bookings").createIndex({ serviceId: 1, eventDate: 1, status: 1 }, { name: "bookings_service_date_status" }),
    db.collection("transactions").createIndex({ vendorId: 1, createdAt: -1 }, { name: "transactions_vendor_created" }),
    db.collection("transactions").createIndex({ stripeSessionId: 1 }, { unique: true, partialFilterExpression: { stripeSessionId: { $type: "string" } }, name: "transactions_stripe_session_unique" }),
    db.collection("transactions").createIndex({ stripeInvoiceId: 1 }, { unique: true, partialFilterExpression: { stripeInvoiceId: { $type: "string" } }, name: "transactions_stripe_invoice_unique" }),
  ]);
  await db.collection("bookingSlots").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "booking_slot_expiry" });
}

async function migrateLegacyBusinessFields() {
  const users = authDb.collection("user");
  await users.updateMany({ blocked: { $exists: true } }, [
    { $set: { isBlocked: { $ifNull: ["$isBlocked", "$blocked"] } } },
    { $unset: "blocked" },
  ]);
  await users.updateMany({ $or: [{ plan: { $exists: true } }, { currentPeriodEnd: { $exists: true } }] }, [
    { $set: {
      subscriptionPlan: { $cond: [
        { $in: [{ $toLower: { $ifNull: ["$plan", ""] } }, ["premium", "pro"]] },
        "$plan",
        { $ifNull: ["$subscriptionPlan", { $ifNull: ["$plan", "free"] }] },
      ] },
      subscriptionExpiresAt: { $ifNull: ["$subscriptionExpiresAt", { $ifNull: ["$currentPeriodEnd", null] }] },
    } },
    { $unset: ["plan", "currentPeriodEnd"] },
  ]);
  await users.updateMany({ isBlocked: { $exists: false } }, { $set: { isBlocked: false } });
  await users.updateMany({ subscriptionPlan: { $exists: false } }, { $set: { subscriptionPlan: "free" } });
  await users.updateMany({ subscriptionExpiresAt: { $exists: false } }, { $set: { subscriptionExpiresAt: null } });

  const services = db.collection("services");
  const legacyImages = services.find({ $or: [{ serviceImage: { $type: "string" } }, { vendor: { $exists: true } }] }, { projection: { images: 1, serviceImage: 1, vendorId: 1, vendor: 1 } });
  for await (const service of legacyImages) {
    const images = Array.isArray(service.images) && service.images.length
      ? service.images
      : typeof service.serviceImage === "string" && service.serviceImage
        ? [service.serviceImage]
        : [];
    const vendorId = service.vendorId || service.vendor?.id || service.vendor?._id;
    await services.updateOne({ _id: service._id }, {
      ...(images.length ? { $set: { images, ...(vendorId ? { vendorId: String(vendorId) } : {}) } } : vendorId ? { $set: { vendorId: String(vendorId) } } : {}),
      $unset: { serviceImage: "", vendorName: "", businessName: "", vendor: "" },
    });
  }
  await services.updateMany({ $or: [{ vendorName: { $exists: true } }, { businessName: { $exists: true } }] }, { $unset: { vendorName: "", businessName: "" } });
  await services.updateMany({ images: { $exists: false } }, { $set: { images: [] } });
  await services.updateMany({ status: { $exists: false } }, { $set: { status: "pending" } });
  await services.updateMany({ isActive: { $exists: false } }, { $set: { isActive: true } });
  await fillMissingCreatedAt(services);

  const bookings = db.collection("bookings");
  const legacyBookings = bookings.find({ $or: [{ service: { $exists: true } }, { customer: { $exists: true } }, { vendor: { $exists: true } }] }, { projection: { serviceId: 1, vendorId: 1, customerId: 1, service: 1, customer: 1, vendor: 1 } });
  for await (const booking of legacyBookings) {
    const serviceId = booking.serviceId || booking.service?.id || booking.service?._id;
    const vendorId = booking.vendorId || booking.vendor?.id || booking.vendor?._id || booking.service?.vendorId || booking.service?.vendor?.id || booking.service?.vendor?._id;
    const customerId = booking.customerId || booking.customer?.id || booking.customer?._id;
    const refs = {
      ...(serviceId ? { serviceId: String(serviceId) } : {}),
      ...(vendorId ? { vendorId: String(vendorId) } : {}),
      ...(customerId ? { customerId: String(customerId) } : {}),
    };
    await bookings.updateOne({ _id: booking._id }, { ...(Object.keys(refs).length ? { $set: refs } : {}), $unset: { service: "", customer: "", vendor: "" } });
  }
  await bookings.updateMany({ status: { $exists: false } }, { $set: { status: "pending" } });
  await fillMissingCreatedAt(bookings);

  const transactions = db.collection("transactions");
  const legacyTransactions = transactions.find({ $or: [
    { amountCents: { $exists: true } }, { paymentAmount: { $exists: true } }, { paymentStatus: { $exists: true } },
    { planName: { $exists: true } }, { transactionDate: { $exists: true } }, { confirmedAt: { $exists: true } },
  ] });
  for await (const transaction of legacyTransactions) {
    const set = {};
    if (typeof transaction.amount !== "number") {
      if (typeof transaction.amountCents === "number") set.amount = fromMinorUnits(transaction.amountCents, transaction.currency);
      else if (typeof transaction.paymentAmount === "number") set.amount = transaction.paymentAmount;
    }
    if (!transaction.plan) set.plan = String(transaction.planName || "premium").toLowerCase();
    if (!transaction.status || transaction.status === "paid") {
      const previousStatus = String(transaction.paymentStatus || transaction.status || "pending").toLowerCase();
      set.status = previousStatus === "paid" ? "succeeded" : ["pending", "failed", "expired", "succeeded"].includes(previousStatus) ? previousStatus : "pending";
    }
    if (!transaction.createdAt && transaction.transactionDate) set.createdAt = new Date(transaction.transactionDate);
    await transactions.updateOne({ _id: transaction._id }, {
      ...(Object.keys(set).length ? { $set: set } : {}),
      $unset: { amountCents: "", paymentAmount: "", paymentStatus: "", planName: "", transactionDate: "", confirmedAt: "", updatedAt: "" },
    });
  }
  await transactions.updateMany({ plan: { $exists: false } }, { $set: { plan: "premium" } });
  await transactions.updateMany({ status: { $exists: false } }, { $set: { status: "pending" } });
  await fillMissingCreatedAt(transactions);
}

async function fillMissingCreatedAt(collection) {
  const missingDates = collection.find({ createdAt: { $exists: false } }, { projection: { _id: 1 } });
  for await (const document of missingDates) {
    const createdAt = typeof document._id?.getTimestamp === "function" ? document._id.getTimestamp() : new Date();
    await collection.updateOne({ _id: document._id, createdAt: { $exists: false } }, { $set: { createdAt } });
  }
}

// ============================================================================
// Authentication
// ============================================================================

// Assigned after the database connection so Better Auth can initialize its
// MongoDB indexes safely.
let auth = null;

function createAuth() {
  const trustedOrigins = [
    process.env.CLIENT_URL,
    process.env.BETTER_AUTH_URL,
    process.env.BETTER_AUTH_TRUSTED_ORIGINS,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((value) => {
      try { return new URL(value.trim()).origin; }
      catch { return ""; }
    })
    .filter(Boolean);

  if (!process.env.BETTER_AUTH_SECRET?.trim()) {
    throw new Error("BETTER_AUTH_SECRET must match the WedPlan client secret so API requests can verify sessions.");
  }

  return betterAuth({
    appName: "WedPlan",
    baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
    trustedOrigins: [...new Set(trustedOrigins)],
    secret: process.env.BETTER_AUTH_SECRET,
    database: mongodbAdapter(authDb, { client: mongoClient }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      // Match the client signup validation (6 characters plus upper/lowercase).
      minPasswordLength: 6,
    },
    user: { additionalFields: {
      role: { type: "string", required: false, defaultValue: "customer", input: true },
      businessName: { type: "string", required: false, input: true },
      isBlocked: { type: "boolean", required: false, defaultValue: false, input: false },
      subscriptionPlan: { type: "string", required: false, defaultValue: "free", input: false },
      subscriptionExpiresAt: { type: "date", required: false, input: false },
      phoneNumber: { type: "string", required: false, input: false },
      location: { type: "string", required: false, input: false },
      bio: { type: "string", required: false, input: false },
    } },
    databaseHooks: { user: {
      update: { before: async (user) => {
        if ("role" in user || "subscriptionPlan" in user || "subscriptionExpiresAt" in user || "isBlocked" in user || "blocked" in user) {
          throw new APIError("FORBIDDEN", { message: "Account role, access, and subscription settings cannot be changed from profile updates." });
        }
        return { data: user };
      } },
    } },
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? {
      socialProviders: { google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET } },
    } : {}),
  });
}

function issueAccessToken(user) {
  return jwt.sign({ role: user.role, ver: Number(user.apiTokenVersion) || 0 }, jwtSecret, {
    algorithm: "HS256", subject: String(user.id), issuer, audience,
    expiresIn: process.env.JWT_ACCESS_TTL?.trim() || "15m",
  });
}

function setAccessTokenCookie(response, token) {
  const secure = process.env.NODE_ENV === "production";
  response.cookie(tokenCookie, token, {
    httpOnly: true,
    secure,
    sameSite: secure ? "none" : "lax",
    path: "/api",
    maxAge: 15 * 60 * 1000,
  });
}

function clearAccessTokenCookie(response) {
  const secure = process.env.NODE_ENV === "production";
  response.clearCookie(tokenCookie, { httpOnly: true, secure, sameSite: secure ? "none" : "lax", path: "/api" });
}

function getToken(request) {
  try {
    const header = request.get("authorization") || "";
    if (/^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, "").trim();
    const cookieHeader = request.headers.cookie || "";
    for (const pair of cookieHeader.split(";")) {
      const [key, ...parts] = pair.trim().split("=");
      if (key === tokenCookie) return decodeURIComponent(parts.join("="));
    }
    return "";
  } catch { return ""; }
}

function verifyAccessToken(request) {
  const token = getToken(request);
  if (!token) return null;
  try {
    const payload = jwt.verify(token, jwtSecret, { algorithms: ["HS256"], issuer, audience });
    // jsonwebtoken validates exp when it exists, but a signed token without an
    // exp claim would otherwise remain valid indefinitely. Access tokens must
    // always be time-limited and have a non-empty subject.
    if (!payload || typeof payload === "string" || typeof payload.sub !== "string" || !payload.sub.trim()) return null;
    if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

async function optionalUser(request, response, next) {
  try {
    const claims = verifyAccessToken(request);
    if (!claims) return next();
    const user = await authDb.collection("user").findOne({ _id: { $in: idOptions(claims.sub) } });
    if (!user || user.isBlocked === true || user.blocked === true) return response.status(403).json({ message: "This account cannot access protected features." });
    if ((Number(claims.ver) || 0) !== (Number(user.apiTokenVersion) || 0)) return response.status(401).json({ message: "Your API session has been revoked. Sign in again to continue." });
    request.user = { ...user, id: String(claims.sub), role: user.role || claims.role || "customer" };
    request.authClaims = claims;
    next();
  } catch (error) { next(error); }
}

function requireUser(request, response, next) {
  return optionalUser(request, response, (error) => {
    if (error) return next(error);
    if (!request.user) return response.status(401).json({ message: "Sign in again to continue. Your API session may have expired." });
    if (request.get("origin")) {
      const allowed = getAllowedClientOrigins();
      if (!allowed.includes(request.get("origin"))) return response.status(403).json({ message: "This request origin is not allowed." });
    }
    response.set("Cache-Control", "no-store");
    next();
  });
}

function requireRole(...roles) {
  return (request, response, next) => {
    if (!request.user) return response.status(401).json({ message: "Sign in again to continue." });
    if (!roles.includes(request.user.role)) return response.status(403).json({ message: "You do not have permission to perform this action." });
    next();
  };
}

function requireAdmin(request, response, next) {
  return requireRole("admin")(request, response, next);
}

// ============================================================================
// Payments (Stripe subscriptions and webhooks)
// ============================================================================

const stripeSecret = process.env.STRIPE_SECRET_KEY?.trim();
const stripe = stripeSecret?.startsWith("sk_test_") ? new Stripe(stripeSecret) : null;
const priceId = process.env.STRIPE_PREMIUM_PRICE_ID?.trim();
const premiumPlans = {
  premium: { name: "Premium", amount: null },
  premium_plus: { name: "Premium Plus", amount: 200 },
  premium_pro: { name: "Premium Pro", amount: 300 },
};

function getPremiumPlan(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(premiumPlans, value)
    ? value
    : "premium";
}

function toMinorUnits(amount, currency) {
  const digits = new Intl.NumberFormat("en", { style: "currency", currency: String(currency || "USD").toUpperCase() }).resolvedOptions().maximumFractionDigits;
  return Math.round(Number(amount) * (10 ** digits));
}

function stripeId(value) {
  if (typeof value === "string") return value;
  return value && typeof value === "object" && typeof value.id === "string" ? value.id : "";
}

const paymentsRouter = Router();

paymentsRouter.get("/subscription", requireUser, requireRole("vendor"), asyncRoute(async (req, res) => {
  const user = await authDb.collection("user").findOne({ _id: { $in: idOptions(req.user.id) } }, { projection: { subscriptionPlan: 1, subscriptionExpiresAt: 1, stripeSubscriptionStatus: 1, cancelAtPeriodEnd: 1 } });
  let price = null;
  if (stripe && priceId) {
    try {
      const configuredPrice = await stripe.prices.retrieve(priceId);
      if (configuredPrice.active && configuredPrice.recurring) {
        price = { unitAmount: configuredPrice.unit_amount ?? 0, currency: configuredPrice.currency, interval: configuredPrice.recurring.interval };
      }
    } catch {
      return res.status(503).json({ message: "The Premium Stripe price could not be loaded. Check STRIPE_PREMIUM_PRICE_ID." });
    }
  }
  res.json({ plan: user?.subscriptionPlan || "free", status: user?.stripeSubscriptionStatus || "none", cancelAtPeriodEnd: user?.cancelAtPeriodEnd === true, subscriptionExpiresAt: user?.subscriptionExpiresAt || null, price });
}));

paymentsRouter.post("/create-checkout-session", requireUser, requireRole("vendor"), asyncRoute(async (req, res) => {
  if (!stripe) return res.status(503).json({ message: "Stripe Test Mode is not configured. Set a server-side STRIPE_SECRET_KEY beginning with sk_test_." });
  if (!priceId) return res.status(503).json({ message: "The Premium Stripe Price ID is not configured on the server." });
  if (/premium/i.test(String(req.user.subscriptionPlan || "")) && req.user.stripeSubscriptionStatus === "active") {
    return res.status(409).json({ message: "This vendor already has an active Premium subscription." });
  }

  const price = await stripe.prices.retrieve(priceId);
  if (!price.active || !price.recurring) return res.status(503).json({ message: "The configured Stripe price must be an active recurring price." });
  if (price.recurring.interval !== "month") return res.status(503).json({ message: "The configured Premium Stripe price must use monthly billing." });
  if (req.body?.plan !== undefined && !Object.prototype.hasOwnProperty.call(premiumPlans, req.body.plan)) return res.status(400).json({ message: "Choose one of the available Premium subscription plans." });
  const plan = getPremiumPlan(req.body?.plan);
  const selectedPlan = premiumPlans[plan];
  const base = (process.env.CLIENT_URL || "http://localhost:3000").split(",")[0].trim().replace(/\/$/, "");
  const customerId = req.user.stripeCustomerId;
  const checkout = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [plan === "premium"
      ? { price: priceId, quantity: 1 }
      : { price_data: { currency: price.currency, unit_amount: toMinorUnits(selectedPlan.amount, price.currency), recurring: { interval: "month" }, product_data: { name: `WedPlan ${selectedPlan.name}` } }, quantity: 1 }],
    ...(customerId ? { customer: customerId } : { customer_email: req.user.email }),
    success_url: `${base}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/payment/cancel`,
    client_reference_id: String(req.user.id),
    metadata: { vendorId: String(req.user.id), plan },
    subscription_data: { metadata: { vendorId: String(req.user.id), plan } },
  });

  await db.collection("transactions").updateOne(
    { stripeSessionId: checkout.id },
    { $setOnInsert: { vendorId: String(req.user.id), plan, amount: plan === "premium" ? fromMinorUnits(price.unit_amount ?? 0, price.currency) : selectedPlan.amount, currency: price.currency, status: "pending", stripeSessionId: checkout.id, createdAt: new Date() } },
    { upsert: true },
  );
  res.json({ url: checkout.url, sessionId: checkout.id });
}));

paymentsRouter.get("/checkout-session/:id", requireUser, requireRole("vendor"), asyncRoute(async (req, res) => {
  if (!stripe) return res.status(503).json({ message: "Stripe Test Mode is not configured." });
  let checkout;
  try { checkout = await stripe.checkout.sessions.retrieve(req.params.id); }
  catch { return res.status(404).json({ message: "Checkout session not found." }); }
  if (checkout.metadata?.vendorId !== String(req.user.id) || checkout.mode !== "subscription") {
    return res.status(404).json({ message: "Checkout session not found." });
  }
  let transaction = await db.collection("transactions").findOne({ stripeSessionId: checkout.id, vendorId: String(req.user.id) });
  if (!transaction) return res.status(404).json({ message: "The checkout record could not be found." });
  if (transaction.status === "pending" && checkout.mode === "subscription" && checkout.status === "complete" && ["paid", "no_payment_required"].includes(checkout.payment_status)) {
    await markCheckoutPaid(checkout);
    transaction = await db.collection("transactions").findOne({ stripeSessionId: checkout.id, vendorId: String(req.user.id) });
  }
  const vendor = await authDb.collection("user").findOne({ _id: { $in: idOptions(req.user.id) } }, { projection: { subscriptionPlan: 1 } });
  const paymentStatus = transaction.status === "succeeded" ? "paid" : ["failed", "expired"].includes(transaction.status) ? transaction.status : "pending";
  const confirmed = paymentStatus === "paid" && /premium/i.test(String(vendor?.subscriptionPlan || ""));
  res.json({ confirmed, paymentStatus, subscriptionPlan: vendor?.subscriptionPlan || "free", message: confirmed ? "Stripe confirmed your Premium subscription." : "Waiting for Stripe to verify the payment." });
}));

async function reconcilePendingTransactions() {
  if (!stripe) throw new Error("Stripe Test Mode is not configured.");
  const pending = await db.collection("transactions")
    .find({ status: "pending", stripeSessionId: { $type: "string" } })
    .sort({ createdAt: 1 })
    .limit(50)
    .toArray();
  const summary = { checked: pending.length, confirmed: 0, expired: 0, stillPending: 0, unverified: 0 };

  for (let index = 0; index < pending.length; index += 5) {
    await Promise.all(pending.slice(index, index + 5).map(async (transaction) => {
      try {
        const checkout = await stripe.checkout.sessions.retrieve(transaction.stripeSessionId);
        const checkoutVendorId = checkout.metadata?.vendorId || checkout.client_reference_id;
        if (checkout.mode !== "subscription" || String(checkoutVendorId || "") !== String(transaction.vendorId || "")) {
          summary.unverified += 1;
          return;
        }
        if (checkout.status === "complete" && ["paid", "no_payment_required"].includes(checkout.payment_status)) {
          await markCheckoutPaid(checkout);
          summary.confirmed += 1;
        } else if (checkout.status === "expired") {
          await db.collection("transactions").updateOne(
            { _id: transaction._id, status: "pending" },
            { $set: { status: "expired", updatedAt: new Date() } },
          );
          summary.expired += 1;
        } else {
          summary.stillPending += 1;
        }
      } catch {
        summary.unverified += 1;
      }
    }));
  }
  return summary;
}

paymentsRouter.post("/create-portal-session", requireUser, requireRole("vendor"), asyncRoute(async (req, res) => {
  if (!stripe) return res.status(503).json({ message: "Stripe Test Mode is not configured." });
  const user = await authDb.collection("user").findOne({ _id: { $in: idOptions(req.user.id) } }, { projection: { stripeCustomerId: 1 } });
  if (!user?.stripeCustomerId) return res.status(409).json({ message: "No Stripe billing profile is linked to this vendor yet." });
  const base = (process.env.CLIENT_URL || "http://localhost:3000").split(",")[0].trim().replace(/\/$/, "");
  const portal = await stripe.billingPortal.sessions.create({ customer: user.stripeCustomerId, return_url: `${base}/dashboard/vendor/subscription` });
  res.json({ url: portal.url });
}));

async function handleStripeWebhook(req, res) {
  if (!stripe) return res.status(503).send("Stripe Test Mode is not configured.");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) return res.status(503).send("Stripe webhook signing secret is not configured.");
  let event;
  const signature = req.get("stripe-signature");
  if (!signature) return res.status(400).send("Stripe signature header is missing.");
  try { event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret); }
  catch (error) { return res.status(400).send(`Webhook signature verification failed: ${error.message}`); }

  const data = event.data.object;
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const paid = event.type === "checkout.session.async_payment_succeeded" || ["paid", "no_payment_required"].includes(data.payment_status);
    if (paid && data.mode === "subscription") await markCheckoutPaid(data);
    else if (!paid) await db.collection("transactions").updateOne({ stripeSessionId: data.id }, { $set: { status: "pending" } });
  } else if (event.type === "checkout.session.expired") {
    await db.collection("transactions").updateOne({ stripeSessionId: data.id }, { $set: { status: "expired" } });
  } else if (event.type === "checkout.session.async_payment_failed") {
    await db.collection("transactions").updateOne({ stripeSessionId: data.id }, { $set: { status: "failed" } });
  } else if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.paused", "customer.subscription.resumed"].includes(event.type)) {
    await syncSubscription(data, event.type);
  } else if (["invoice.paid", "invoice.payment_succeeded", "invoice.payment_failed"].includes(event.type)) {
    await recordInvoice(data, event.type);
  }
  res.json({ received: true });
}

async function markCheckoutPaid(checkout) {
  const vendorId = checkout.metadata?.vendorId || checkout.client_reference_id;
  if (!vendorId) return;
  const plan = getPremiumPlan(checkout.metadata?.plan);
  const subscriptionId = stripeId(checkout.subscription);
  const subscription = subscriptionId ? await stripe.subscriptions.retrieve(subscriptionId) : null;
  const periodEnd = subscription?.current_period_end || subscription?.items?.data?.[0]?.current_period_end;
  const paymentUpdate = { vendorId, plan, status: "succeeded", stripeSubscriptionId: subscriptionId || null };
  if (typeof checkout.amount_total === "number") paymentUpdate.amount = fromMinorUnits(checkout.amount_total, checkout.currency || "USD");
  if (typeof checkout.currency === "string") paymentUpdate.currency = checkout.currency;
  await db.collection("transactions").updateOne(
    { stripeSessionId: checkout.id },
    { $set: paymentUpdate, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  await authDb.collection("user").updateOne({ _id: { $in: idOptions(vendorId) } }, { $set: { subscriptionPlan: plan, subscriptionExpiresAt: periodEnd ? new Date(periodEnd * 1000) : null, stripeCustomerId: stripeId(checkout.customer), stripeSubscriptionId: subscriptionId, stripeSubscriptionStatus: subscription?.status || "active", cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end), updatedAt: new Date() } });
}

async function syncSubscription(subscription, eventType) {
  const vendorId = await resolveVendorId(subscription.metadata?.vendorId, stripeId(subscription.customer));
  if (!vendorId) return;
  const active = ["active", "trialing"].includes(subscription.status);
  const plan = getPremiumPlan(subscription.metadata?.plan);
  const periodEnd = subscription.current_period_end || subscription.items?.data?.[0]?.current_period_end;
  await authDb.collection("user").updateOne({ _id: { $in: idOptions(vendorId) } }, { $set: {
    subscriptionPlan: active ? plan : "free",
    stripeCustomerId: stripeId(subscription.customer),
    stripeSubscriptionId: subscription.id,
    stripeSubscriptionStatus: eventType === "customer.subscription.deleted" ? "canceled" : subscription.status,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    subscriptionExpiresAt: periodEnd ? new Date(periodEnd * 1000) : null,
    updatedAt: new Date(),
  } });
}

async function recordInvoice(invoice, eventType) {
  const subscriptionId = stripeId(invoice.subscription) || stripeId(invoice.parent?.subscription_details?.subscription);
  if (!subscriptionId) return;
  let subscription;
  try { subscription = await stripe.subscriptions.retrieve(subscriptionId); } catch { return; }
  const vendorId = await resolveVendorId(subscription.metadata?.vendorId, stripeId(invoice.customer));
  if (!vendorId) return;
  const plan = getPremiumPlan(subscription.metadata?.plan);
  const paid = eventType !== "invoice.payment_failed";
  await db.collection("transactions").updateOne(
    { stripeInvoiceId: invoice.id },
    { $set: { vendorId, plan, amount: fromMinorUnits(paid ? invoice.amount_paid : invoice.amount_due, invoice.currency), currency: invoice.currency, status: paid ? "succeeded" : "failed", stripeInvoiceId: invoice.id, stripeSubscriptionId: subscriptionId }, $setOnInsert: { createdAt: invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000) : new Date((invoice.created || Date.now() / 1000) * 1000) } },
    { upsert: true },
  );
  if (paid && ["active", "trialing"].includes(subscription.status)) {
    const periodEnd = subscription.current_period_end || subscription.items?.data?.[0]?.current_period_end;
    await authDb.collection("user").updateOne({ _id: { $in: idOptions(vendorId) } }, { $set: { subscriptionPlan: plan, subscriptionExpiresAt: periodEnd ? new Date(periodEnd * 1000) : null, stripeSubscriptionStatus: subscription.status, stripeCustomerId: stripeId(invoice.customer), stripeSubscriptionId: subscriptionId, updatedAt: new Date() } });
  }
}

async function resolveVendorId(metadataVendorId, customerId) {
  if (metadataVendorId) return String(metadataVendorId);
  if (!customerId) return "";
  const user = await authDb.collection("user").findOne({ stripeCustomerId: customerId }, { projection: { _id: 1 } });
  return user ? String(user._id) : "";
}

// ============================================================================
// Services routes
// ============================================================================

const servicesRouter = Router();
const servicesCollection = () => db.collection("services");
const usersCollection = () => authDb.collection("user");

servicesRouter.get("/", optionalUser, asyncRoute(async (req, res) => {
  const { search = "", category, location, sort = "", page = "1", limit = "100" } = req.query;
  const vendorRequested = Boolean(req.query.vendorId);
  if (vendorRequested && (!req.user || req.user.role !== "vendor")) return res.status(req.user ? 403 : 401).json({ message: "Sign in with a vendor account to view your services." });
  const filter = vendorRequested ? { vendorId: { $in: idOptions(req.user.id) } } : { status: "approved", isActive: true };
  if (category) filter.category = String(category).slice(0, 100);
  if (location) filter.location = { $regex: escapeRegex(String(location).slice(0, 100)), $options: "i" };
  const searchTerms = String(search).slice(0, 100).trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (searchTerms.length) {
    const searchableFields = ["serviceName", "category", "description", "location"];
    filter.$and = await Promise.all(searchTerms.map(async (term) => {
      const expression = { $regex: escapeRegex(term), $options: "i" };
      const matchingVendors = await usersCollection().find({ $or: [{ name: expression }, { businessName: expression }] }, { projection: { _id: 1 } }).limit(100).toArray();
      const vendorIds = matchingVendors.flatMap((vendor) => idOptions(String(vendor._id)));
      const alternatives = searchableFields.map((field) => ({ [field]: expression }));
      if (vendorIds.length) alternatives.push({ vendorId: { $in: vendorIds } });
      return { $or: alternatives };
    }));
  }
  const take = Math.max(1, Math.min(Number(limit) || 100, 100));
  const currentPage = Math.max(1, Number(page) || 1);
  const sortSpec = ["low", "price-asc"].includes(String(sort)) ? { price: 1, _id: 1 } : ["high", "price-desc"].includes(String(sort)) ? { price: -1, _id: 1 } : { createdAt: -1, _id: -1 };
  const results = await servicesCollection().find(filter).sort(sortSpec).skip((currentPage - 1) * take).limit(take).toArray();
  res.json(await Promise.all(results.map(enrichService)));
}));

servicesRouter.get("/:id", asyncRoute(async (req, res) => {
  const service = await servicesCollection().findOne({ _id: { $in: idOptions(req.params.id) }, status: "approved", isActive: true });
  if (!service) return res.status(404).json({ message: "This service is not available." });
  res.json(await enrichService(service));
}));

servicesRouter.post("/", requireUser, requireRole("vendor"), asyncRoute(async (req, res) => {
  const input = validateService(req.body, true);
  if (input.error) return res.status(400).json({ message: input.error });
  const vendorId = String(req.user.id);
  const user = await usersCollection().findOne({ _id: { $in: idOptions(vendorId) } });
  const premium = /^premium(?:_|$)/i.test(String(user?.subscriptionPlan || "")) || String(user?.subscriptionPlan || "").toLowerCase() === "pro";
  if (!premium) {
    const activeCount = await servicesCollection().countDocuments({ vendorId: { $in: idOptions(vendorId) }, isActive: true, status: "approved" });
    if (activeCount >= 3) return res.status(403).json({ message: "The free plan allows up to 3 active services. Upgrade to Premium to add more." });
  }
  const document = { ...input.value, vendorId, status: "pending", isActive: input.value.isActive !== false, createdAt: new Date(), updatedAt: new Date() };
  const result = await servicesCollection().insertOne(document);
  res.status(201).json({ ...document, _id: result.insertedId });
}));

servicesRouter.patch("/:id", requireUser, requireRole("vendor"), asyncRoute(async (req, res) => {
  const input = validateService(req.body, false);
  if (input.error) return res.status(400).json({ message: input.error });
  const requiresReview = Object.keys(input.value).some((field) => field !== "isActive");
  const update = { ...input.value, updatedAt: new Date() };
  if (requiresReview) update.status = "pending";
  const result = await servicesCollection().findOneAndUpdate(
    { _id: { $in: idOptions(req.params.id) }, vendorId: { $in: idOptions(req.user.id) } },
    { $set: update }, { returnDocument: "after" },
  );
  if (!result) return res.status(404).json({ message: "Service not found or not owned by your account." });
  res.json(result);
}));

servicesRouter.delete("/:id", requireUser, requireRole("vendor"), asyncRoute(async (req, res) => {
  const result = await servicesCollection().deleteOne({ _id: { $in: idOptions(req.params.id) }, vendorId: { $in: idOptions(req.user.id) } });
  if (!result.deletedCount) return res.status(404).json({ message: "Service not found or not owned by your account." });
  res.status(204).end();
}));

async function enrichService(service) {
  const vendorId = service.vendorId ? String(service.vendorId) : "";
  const vendor = vendorId ? await usersCollection().findOne({ _id: { $in: idOptions(vendorId) } }, { projection: { name: 1, email: 1, image: 1, businessName: 1 } }) : null;
  return { ...service, vendor: vendor || service.vendor || null };
}

function validateService(body = {}, creating) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Provide service details as a JSON object." };
  const serviceName = String(body.serviceName || "").trim();
  const category = String(body.category || "").trim();
  const description = String(body.description || "").trim();
  const location = String(body.location || "").trim();
  const price = Number(body.price);
  const images = Array.isArray(body.images) ? body.images.filter((image) => typeof image === "string").slice(0, 12) : [];
  if (creating && (!serviceName || !category || !description || !location || !Number.isFinite(price) || price < 0 || !images.length)) {
    return { error: "Name, category, description, price, location, and at least one service image are required." };
  }
  const value = {};
  if (serviceName) value.serviceName = serviceName.slice(0, 120);
  if (category) value.category = category.slice(0, 100);
  if (description) value.description = description.slice(0, 5000);
  if (location) value.location = location.slice(0, 200);
  if (body.price !== undefined && Number.isFinite(price) && price >= 0) value.price = price;
  else if (body.price !== undefined) return { error: "Price must be a non-negative number." };
  if (body.images !== undefined) {
    if (!Array.isArray(body.images) || images.length !== body.images.length || images.some((image) => !isAllowedImageUrl(image))) {
      return { error: "Service images must be valid HTTPS image URLs." };
    }
    value.images = images;
  }
  if (body.currency) value.currency = String(body.currency).slice(0, 5);
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") return { error: "Service availability must be true or false." };
    value.isActive = body.isActive;
  }
  if (!creating && Object.keys(value).length === 0) return { error: "Provide at least one valid service field to update." };
  return { value };
}

// ============================================================================
// Bookings routes
// ============================================================================

const bookingsRouter = Router();
const bookingsCollection = () => db.collection("bookings");

bookingsRouter.get("/", requireUser, requireRole("customer"), asyncRoute(async (req, res) => {
  const list = await bookingsCollection().find({ customerId: String(req.user.id) }).sort({ createdAt: -1 }).limit(100).toArray();
  res.json(await Promise.all(list.map(enrichBooking)));
}));

bookingsRouter.post("/", requireUser, requireRole("customer"), asyncRoute(async (req, res) => {
  const serviceId = typeof req.body?.serviceId === "string" ? req.body.serviceId.trim() : "";
  const eventDate = typeof req.body?.eventDate === "string" ? req.body.eventDate.trim() : "";
  const eventLocation = typeof req.body?.eventLocation === "string" ? req.body.eventLocation.trim() : "";
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(eventDate) ? new Date(`${eventDate}T00:00:00.000Z`) : null;
  if (!serviceId || serviceId.length > 100 || !date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== eventDate || eventDate < new Date().toISOString().slice(0, 10) || !eventLocation || eventLocation.length > 200 || message.length > 2000) {
    return res.status(400).json({ message: "Choose today or a future event date and enter a valid location. The message must be 2,000 characters or less." });
  }
  const service = await db.collection("services").findOne({ _id: { $in: idOptions(serviceId) }, status: "approved", isActive: true });
  if (!service) return res.status(404).json({ message: "This service is no longer available for booking." });
  const vendorId = String(service.vendorId || service.vendor?.id || service.vendor?._id || "");
  if (!vendorId) return res.status(409).json({ message: "Vendor details are missing for this service." });
  if (vendorId === String(req.user.id)) return res.status(403).json({ message: "You cannot book your own service." });
  const canonicalServiceId = service._id instanceof ObjectId ? service._id.toHexString() : String(service._id);
  const duplicate = await bookingsCollection().findOne({ serviceId: { $in: idOptions(canonicalServiceId) }, eventDate, status: { $in: ["pending", "accepted"] } });
  if (duplicate) return res.status(409).json({ message: "An active booking request already exists for this service and event date." });

  // Reserve the service/date slot atomically so simultaneous requests cannot
  // both pass the duplicate check. A TTL expiry cleans up abandoned reservations.
  const slotId = `${canonicalServiceId}:${eventDate}`;
  const reservationToken = new ObjectId();
  try {
    await db.collection("bookingSlots").insertOne({ _id: slotId, token: reservationToken, expiresAt: new Date(Date.now() + 10 * 60 * 1000) });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const previous = await db.collection("bookingSlots").findOne({ _id: slotId });
    const previousBooking = previous?.bookingId ? await bookingsCollection().findOne({ _id: previous.bookingId, status: { $in: ["pending", "accepted"] } }) : null;
    const reservationStillLive = previous && !previous.bookingId && previous.expiresAt && previous.expiresAt > new Date();
    if (previousBooking || reservationStillLive || !previous) return res.status(409).json({ message: "An active booking request already exists for this service and event date." });
    await db.collection("bookingSlots").deleteOne({ _id: slotId, token: previous.token });
    try { await db.collection("bookingSlots").insertOne({ _id: slotId, token: reservationToken, expiresAt: new Date(Date.now() + 10 * 60 * 1000) }); }
    catch (retryError) { if (retryError?.code === 11000) return res.status(409).json({ message: "An active booking request already exists for this service and event date." }); throw retryError; }
  }

  const bookingId = new ObjectId();
  const booking = { _id: bookingId, serviceId: canonicalServiceId, vendorId, customerId: String(req.user.id), eventDate, eventLocation, ...(message ? { message } : {}), status: "pending", createdAt: new Date(), updatedAt: new Date() };
  try {
    await bookingsCollection().insertOne(booking);
    await db.collection("bookingSlots").updateOne({ _id: slotId, token: reservationToken }, { $set: { bookingId, expiresAt: null } });
    res.status(201).json(booking);
  } catch (error) {
    await db.collection("bookingSlots").deleteOne({ _id: slotId, token: reservationToken });
    if (error?.code === 11000) return res.status(409).json({ message: "An active booking request already exists for this service and event date." });
    throw error;
  }
}));

bookingsRouter.get("/vendor", requireUser, requireRole("vendor"), asyncRoute(async (req, res) => {
  const list = await bookingsCollection().find({ vendorId: { $in: idOptions(req.user.id) } }).sort({ createdAt: -1 }).limit(100).toArray();
  res.json(await Promise.all(list.map(enrichBooking)));
}));

bookingsRouter.patch("/:id", requireUser, asyncRoute(async (req, res) => {
  const status = req.body?.status;
  const filter = { _id: { $in: idOptions(req.params.id) }, status: "pending" };
  if (req.user.role === "customer" && status === "cancelled") filter.customerId = String(req.user.id);
  else if (req.user.role === "vendor" && ["accepted", "rejected"].includes(status)) filter.vendorId = { $in: idOptions(req.user.id) };
  else return res.status(403).json({ message: "Your account cannot make this booking status change." });
  const result = await bookingsCollection().findOneAndUpdate(filter, { $set: { status, updatedAt: new Date() } }, { returnDocument: "after" });
  if (!result) return res.status(409).json({ message: "This booking is not yours or is no longer pending." });
  if (status === "cancelled" || status === "rejected") await db.collection("bookingSlots").deleteOne({ _id: `${result.serviceId}:${result.eventDate}` });
  res.json(result);
}));

async function enrichBooking(booking) {
  const service = booking.serviceId ? await db.collection("services").findOne({ _id: { $in: idOptions(booking.serviceId) } }) : null;
  const customer = booking.customerId ? await authDb.collection("user").findOne({ _id: { $in: idOptions(booking.customerId) } }, { projection: { name: 1, email: 1, image: 1 } }) : null;
  const vendorId = booking.vendorId || service?.vendorId;
  const vendor = vendorId ? await authDb.collection("user").findOne({ _id: { $in: idOptions(vendorId) } }, { projection: { name: 1, email: 1, image: 1, businessName: 1 } }) : null;
  return { ...booking, service: service ? { ...service, vendor } : null, customer: customer || null, vendor: vendor || null };
}

// ============================================================================
// Vendor bookings routes
// ============================================================================

const vendorBookingsRouter = Router();
vendorBookingsRouter.use(requireUser, requireRole("vendor"));

vendorBookingsRouter.get("/", asyncRoute(async (req, res) => {
  const list = await db.collection("bookings").find({ vendorId: { $in: idOptions(req.user.id) } }).sort({ createdAt: -1 }).limit(100).toArray();
  const enriched = await Promise.all(list.map(async (booking) => {
    const [service, customer, vendor] = await Promise.all([
      db.collection("services").findOne({ _id: { $in: idOptions(booking.serviceId) } }),
      authDb.collection("user").findOne({ _id: { $in: idOptions(booking.customerId) } }, { projection: { name: 1, email: 1, image: 1 } }),
      authDb.collection("user").findOne({ _id: { $in: idOptions(req.user.id) } }, { projection: { name: 1, email: 1, image: 1, businessName: 1 } }),
    ]);
    return { ...booking, service: service ? { ...service, vendor } : null, customer: customer || null, vendor: vendor || null };
  }));
  res.json(enriched);
}));

vendorBookingsRouter.patch("/:id", asyncRoute(async (req, res) => {
  const status = req.body?.status;
  if (!(["accepted", "rejected"].includes(status))) return res.status(400).json({ message: "Choose accepted or rejected." });
  const booking = await db.collection("bookings").findOneAndUpdate(
    { _id: { $in: idOptions(req.params.id) }, vendorId: { $in: idOptions(req.user.id) }, status: "pending" },
    { $set: { status, updatedAt: new Date() } }, { returnDocument: "after" },
  );
  if (!booking) return res.status(409).json({ message: "This request is not yours or is no longer pending." });
  if (status === "rejected") await db.collection("bookingSlots").deleteOne({ _id: `${booking.serviceId}:${booking.eventDate}` });
  res.json(booking);
}));

// ============================================================================
// Profile routes
// ============================================================================

const profileRouter = Router();

profileRouter.patch("/", requireUser, requireRole("vendor", "customer"), asyncRoute(async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return res.status(400).json({ message: "Provide profile fields as a JSON object." });
  const forbidden = ["role", "subscriptionPlan", "subscriptionExpiresAt", "plan", "isBlocked", "blocked", "stripeCustomerId", "stripeSubscriptionId"];
  if (forbidden.some((key) => Object.prototype.hasOwnProperty.call(body, key))) {
    return res.status(403).json({ message: "Role, access, and subscription settings cannot be changed through profile settings." });
  }

  const update = {};
  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 100) return res.status(400).json({ message: "Name is required and must be 100 characters or fewer." });
    update.name = body.name.trim();
  }
  if (Object.prototype.hasOwnProperty.call(body, "image")) {
    if (typeof body.image !== "string" || body.image.length > 2048 || (body.image && !isAllowedImageUrl(body.image))) return res.status(400).json({ message: "Profile image must be a valid HTTPS image URL." });
    update.image = body.image || null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "businessName")) {
    if (req.user.role !== "vendor") return res.status(403).json({ message: "Only vendors can update a business name." });
    if (typeof body.businessName !== "string" || !body.businessName.trim() || body.businessName.trim().length > 120) return res.status(400).json({ message: "Business name is required and must be 120 characters or fewer." });
    update.businessName = body.businessName.trim();
  }
  for (const [key, max] of [["phoneNumber", 32], ["location", 120], ["bio", 500]]) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    if (typeof body[key] !== "string" || body[key].trim().length > max) return res.status(400).json({ message: `${key} must be ${max} characters or fewer.` });
    update[key] = body[key].trim();
  }
  if (!Object.keys(update).length) return res.status(400).json({ message: "No editable profile fields were provided." });
  update.updatedAt = new Date();

  const user = await authDb.collection("user").findOneAndUpdate(
    { _id: { $in: idOptions(req.user.id) } },
    { $set: update },
    { returnDocument: "after", projection: { name: 1, email: 1, image: 1, role: 1, businessName: 1, phoneNumber: 1, location: 1, bio: 1, subscriptionPlan: 1, subscriptionExpiresAt: 1 } },
  );
  if (!user) return res.status(404).json({ message: "Your account could not be found." });
  res.json({ profile: user, message: "Profile saved successfully." });
}));

// ============================================================================
// Auth token routes
// ============================================================================

const authTokenRouter = Router();

authTokenRouter.post("/token", async (request, response, next) => {
  try {
    const origin = request.get("origin");
    const allowed = getAllowedClientOrigins();
    if (origin && !allowed.includes(origin)) return response.status(403).json({ message: "This request origin is not allowed." });

    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(", "));
    }
    const session = await auth.api.getSession({ headers });
    if (!session) {
      clearAccessTokenCookie(response);
      return response.status(401).json({ message: "Sign in to establish an API session." });
    }

    const user = await authDb.collection("user").findOne({ _id: { $in: idOptions(session.user.id) } });
    if (!user || user.isBlocked === true || user.blocked === true) {
      clearAccessTokenCookie(response);
      return response.status(403).json({ message: "This account cannot access protected features." });
    }
    if (!["admin", "vendor", "customer"].includes(user.role)) return response.status(403).json({ message: "This account role is not authorized for WedPlan API access." });

    const token = issueAccessToken({ id: session.user.id, role: user.role, apiTokenVersion: user.apiTokenVersion });
    setAccessTokenCookie(response, token);
    response.set("Cache-Control", "no-store");
    return response.json({ authenticated: true, expiresIn: process.env.JWT_ACCESS_TTL?.trim() || "15m" });
  } catch (error) { next(error); }
});

authTokenRouter.delete("/token", async (request, response, next) => {
  try {
    const claims = verifyAccessToken(request);
    if (claims?.sub) await authDb.collection("user").updateOne({ _id: { $in: idOptions(claims.sub) } }, { $inc: { apiTokenVersion: 1 } });
  } catch (error) { return next(error); }
  clearAccessTokenCookie(response);
  response.set("Cache-Control", "no-store");
  response.status(204).end();
});

// ============================================================================
// Admin routes
// ============================================================================

const adminRouter = Router();
adminRouter.use(requireUser, requireAdmin);

adminRouter.get("/overview", asyncRoute(async (_req, res) => {
  const [totalUsers, vendors, customers, totalServices, pendingServices, totalTransactions] = await Promise.all([
    authDb.collection("user").countDocuments(), authDb.collection("user").countDocuments({ role: "vendor" }), authDb.collection("user").countDocuments({ role: "customer" }),
    db.collection("services").countDocuments(), db.collection("services").countDocuments({ $or: [{ status: "pending" }, { status: { $exists: false } }] }), db.collection("transactions").countDocuments(),
  ]);
  res.json({ totalUsers, vendors, customers, totalServices, pendingServices, totalTransactions });
}));

adminRouter.get("/users", asyncRoute(async (req, res) => {
  const search = String(req.query.search || "").trim().slice(0, 100);
  const role = String(req.query.role || "all");
  const page = Math.max(1, Number(req.query.page) || 1);
  const filter = {};
  if (["admin", "vendor", "customer"].includes(role)) filter.role = role;
  if (search) { const re = new RegExp(escapeRegex(search), "i"); filter.$or = [{ name: re }, { email: re }]; }
  const [list, total] = await Promise.all([
    authDb.collection("user").find(filter).project({ name: 1, email: 1, role: 1, image: 1, isBlocked: 1, blocked: 1, createdAt: 1, businessName: 1 }).sort({ createdAt: -1 }).skip((page - 1) * 20).limit(20).toArray(),
    authDb.collection("user").countDocuments(filter),
  ]);
  res.json({ users: list.map(({ blocked, ...user }) => ({ ...user, isBlocked: user.isBlocked ?? blocked ?? false })), total, page, limit: 20 });
}));

adminRouter.patch("/users/:id", asyncRoute(async (req, res) => {
  if (String(req.user.id) === String(req.params.id)) return res.status(400).json({ message: "You cannot block your own admin account." });
  const isBlocked = req.body?.isBlocked ?? req.body?.blocked;
  if (typeof isBlocked !== "boolean") return res.status(400).json({ message: "Provide isBlocked as true or false." });
  const user = await authDb.collection("user").findOneAndUpdate({ _id: { $in: idOptions(req.params.id) } }, { $set: { isBlocked, updatedAt: new Date() }, $unset: { blocked: "" } }, { returnDocument: "after", projection: { name: 1, email: 1, role: 1, isBlocked: 1 } });
  if (!user) return res.status(404).json({ message: "User not found." });
  res.json(user);
}));

adminRouter.delete("/users/:id", asyncRoute(async (req, res) => {
  const targetId = String(req.params.id || "").trim();
  if (!targetId) return res.status(400).json({ message: "A user ID is required." });
  if (String(req.user.id) === targetId) return res.status(400).json({ message: "You cannot delete your own admin account." });

  const userCollection = authDb.collection("user");
  const user = await userCollection.findOne({ _id: { $in: idOptions(targetId) } });
  if (!user) return res.status(404).json({ message: "User not found." });
  if (!(["vendor", "customer"].includes(String(user.role)))) {
    return res.status(403).json({ message: "Admin accounts cannot be deleted from user management." });
  }

  // A vendor's listings must immediately stop appearing in public results.
  if (user.role === "vendor") {
    await db.collection("services").updateMany(
      { vendorId: { $in: idOptions(targetId) } },
      { $set: { status: "rejected", isActive: false, updatedAt: new Date() } },
    );
  }

  const result = await userCollection.deleteOne({ _id: user._id });
  if (!result.deletedCount) return res.status(404).json({ message: "User was already deleted." });

  // Remove Better Auth credentials and sessions so the deleted account cannot
  // establish another session. Missing user records also invalidate API JWTs.
  const userId = String(user._id);
  const authCleanup = await Promise.allSettled([
    authDb.collection("session").deleteMany({ userId }),
    authDb.collection("account").deleteMany({ userId }),
  ]);
  if (authCleanup.some((item) => item.status === "rejected")) {
    console.error("WedPlan removed an admin-selected user but could not clean up every authentication record.");
  }

  res.json({ message: "User deleted. Existing sessions are no longer authorized." });
}));

adminRouter.get("/services", asyncRoute(async (req, res) => {
  const status = String(req.query.status || "all");
  const search = String(req.query.search || "").trim().slice(0, 100);
  const clauses = [];
  if (status === "pending") clauses.push({ $or: [{ status: "pending" }, { status: { $exists: false } }] });
  else if (["approved", "rejected"].includes(status)) clauses.push({ status });
  if (search) { const re = new RegExp(escapeRegex(search), "i"); clauses.push({ $or: [{ serviceName: re }, { category: re }, { location: re }] }); }
  const filter = clauses.length ? { $and: clauses } : {};
  const services = await db.collection("services").find(filter).sort({ createdAt: -1 }).limit(300).toArray();
  res.json(await Promise.all(services.map(async (service) => {
    const vendor = service.vendorId ? await authDb.collection("user").findOne({ _id: { $in: idOptions(service.vendorId) } }, { projection: { name: 1, email: 1, businessName: 1 } }) : null;
    return { ...service, vendor: vendor || service.vendor };
  })));
}));

adminRouter.patch("/services/:id", asyncRoute(async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body?.status !== undefined) {
    if (!["approved", "rejected", "pending"].includes(req.body.status)) return res.status(400).json({ message: "Invalid service status." });
    if (req.body.status === "approved") {
      const current = await db.collection("services").findOne({ _id: { $in: idOptions(req.params.id) } });
      if (!current) return res.status(404).json({ message: "Service not found." });
      const vendorId = String(current.vendorId || "");
      const vendor = vendorId ? await authDb.collection("user").findOne({ _id: { $in: idOptions(vendorId) } }) : null;
      const premium = /^premium(?:_|$)/i.test(String(vendor?.subscriptionPlan || "")) || String(vendor?.subscriptionPlan || "").toLowerCase() === "pro";
      if (!premium) {
        const activeCount = await db.collection("services").countDocuments({ vendorId: { $in: idOptions(vendorId) }, isActive: true, status: "approved", _id: { $ne: current._id } });
        if (activeCount >= 3) return res.status(409).json({ message: "This vendor has reached the Free plan limit of 3 active services." });
      }
    }
    update.status = req.body.status;
  }
  if (req.body?.isActive !== undefined) {
    if (typeof req.body.isActive !== "boolean") return res.status(400).json({ message: "Service availability must be true or false." });
    update.isActive = req.body.isActive;
  }
  if (Object.keys(update).length === 1) return res.status(400).json({ message: "Provide a service status or availability change." });
  const service = await db.collection("services").findOneAndUpdate({ _id: { $in: idOptions(req.params.id) } }, { $set: update }, { returnDocument: "after" });
  if (!service) return res.status(404).json({ message: "Service not found." });
  res.json(service);
}));

adminRouter.delete("/services/:id", asyncRoute(async (req, res) => {
  const result = await db.collection("services").deleteOne({ _id: { $in: idOptions(req.params.id) } });
  if (!result.deletedCount) return res.status(404).json({ message: "Service not found." });
  res.status(204).end();
}));

adminRouter.get("/transactions", asyncRoute(async (_req, res) => {
  const items = await db.collection("transactions").find({}).project({ vendorId: 1, plan: 1, amount: 1, currency: 1, stripeSessionId: 1, stripeSubscriptionId: 1, stripeInvoiceId: 1, status: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(300).toArray();
  res.json(await Promise.all(items.map(async (transaction) => {
    const vendor = transaction.vendorId ? await authDb.collection("user").findOne({ _id: { $in: idOptions(transaction.vendorId) } }, { projection: { name: 1, email: 1, businessName: 1 } }) : null;
    return { ...transaction, vendor: vendor || transaction.vendor };
  })));
}));

adminRouter.post("/transactions/reconcile", asyncRoute(async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store").json(await reconcilePendingTransactions());
  } catch (error) {
    res.status(503).json({ message: error instanceof Error ? error.message : "Could not verify pending Stripe transactions." });
  }
}));

// ============================================================================
// Express application
// ============================================================================

const app = express();
const allowedOrigins = getAllowedClientOrigins();

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("This origin is not allowed by the API."));
  },
  credentials: true,
}));

// Stripe needs the original body bytes to verify its signature.
app.post("/api/payments/webhook", express.raw({ type: "application/json" }), async (request, response, next) => {
  try {
    await handleStripeWebhook(request, response);
  } catch (error) { next(error); }
});
app.use(express.json({ limit: "2mb" }));

app.get("/", (_request, response) => {
  response.type("text/plain").send("WedPlan API server listening on");
});

app.get("/api/health", (_request, response) => response.json({ status: "ok", service: "wedplan-server" }));

try {
  // Connect first. Better Auth initializes MongoDB indexes when it is created,
  // so building it before Mongo is ready causes noisy MongoTopologyClosedError
  // messages.
  await connectDatabase();
} catch (error) {
  console.error("WedPlan could not connect to MongoDB.");
  console.error("Check that MONGODB_URL is correct and that the database is running/reachable.");
  console.error(error.message);
  process.exit(1);
}

auth = createAuth();

app.use("/api/services", servicesRouter);
app.use("/api/bookings", bookingsRouter);
app.use("/api/vendor/bookings", vendorBookingsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/auth", authTokenRouter);
app.use("/api/profile", profileRouter);
app.use("/api/payments", paymentsRouter);

// Local development helper for inspecting the users stored in MongoDB.
// It is disabled in production so personal data is never exposed publicly.
if (process.env.NODE_ENV !== "production") {
  app.get("/user", async (_request, response, next) => {
    try {
      const [users, totalDocuments] = await Promise.all([
        authDb.collection("user")
          .find({})
          .project({
            name: 1,
            email: 1,
            role: 1,
            image: 1,
            businessName: 1,
            isBlocked: 1,
            subscriptionPlan: 1,
            createdAt: 1,
          })
          .sort({ createdAt: -1 })
          .limit(100)
          .toArray(),
        authDb.collection("user").countDocuments(),
      ]);

      response.set("Cache-Control", "no-store").json({
        collection: "user",
        totalDocuments,
        returned: users.length,
        users,
      });
    } catch (error) {
      next(error);
    }
  });
}

app.use((_request, response) => response.status(404).json({ message: "API endpoint not found." }));
app.use((error, _request, response, _next) => {
  console.error("WedPlan API error:", error);
  if (response.headersSent) return;
  const parserError = error?.type === "entity.parse.failed";
  const duplicateError = error?.code === 11000;
  const candidateStatus = Number(error?.status ?? error?.statusCode);
  const status = parserError ? 400 : duplicateError ? 409 : Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus <= 599 ? candidateStatus : 500;
  const message = parserError
    ? "Request body must contain valid JSON."
    : duplicateError
      ? "A record with these details already exists."
      : status < 500 && typeof error?.message === "string"
        ? error.message
        : "An unexpected server error occurred. Please try again.";
  response.status(status).json({ message });
});

app.listen(port, () => console.log("WedPlan API server listening on"));

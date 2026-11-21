import { Router } from "express";
import Stripe from "stripe";
import { authDb, db } from "../config/database.js";
import { requireRole, requireUser } from "../middleware/auth.js";
import { asyncRoute } from "../utils/async-route.js";
import { idOptions } from "../utils/ids.js";

export const paymentsRouter = Router();
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

export async function reconcilePendingTransactions() {
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

export async function handleStripeWebhook(req, res) {
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

function fromMinorUnits(amount, currency) {
  const code = String(currency || "USD").toUpperCase();
  const digits = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
  return Number((Number(amount || 0) / (10 ** digits)).toFixed(digits));
}

function stripeId(value) {
  if (typeof value === "string") return value;
  return value && typeof value === "object" && typeof value.id === "string" ? value.id : "";
}

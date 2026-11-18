import { Router } from "express";
import Stripe from "stripe";
import { db } from "../config/database.js";
import { requireRole, requireUser } from "../middleware/auth.js";
import { asyncRoute } from "../utils/async-route.js";
import { idOptions } from "../utils/ids.js";

export const paymentsRouter = Router();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

paymentsRouter.post("/create-checkout-session", requireUser, requireRole("vendor"), asyncRoute(async (req, res) => {
  if (!stripe) return res.status(503).json({ message: "Payments are not configured yet." });
  const priceId = process.env.STRIPE_PREMIUM_PRICE_ID;
  if (!priceId) return res.status(503).json({ message: "The Premium plan price is not configured." });
  const base = (process.env.CLIENT_URL || "http://localhost:3000").split(",")[0].trim().replace(/\/$/, "");
  const checkout = await stripe.checkout.sessions.create({
    mode: "subscription", payment_method_types: ["card"], line_items: [{ price: priceId, quantity: 1 }],
    customer_email: req.user.email,
    success_url: `${base}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/payment/cancel`,
    metadata: { vendorId: String(req.user.id), plan: "premium" },
    subscription_data: { metadata: { vendorId: String(req.user.id), plan: "premium" } },
  });
  await db.collection("transactions").updateOne(
    { stripeSessionId: checkout.id },
    { $setOnInsert: { vendorId: String(req.user.id), plan: "premium", planName: "Premium", amountCents: checkout.amount_total ?? null, currency: checkout.currency || "usd", status: "pending", paymentStatus: "pending", stripeSessionId: checkout.id, createdAt: new Date() } },
    { upsert: true },
  );
  res.json({ url: checkout.url, sessionId: checkout.id });
}));

export async function handleStripeWebhook(req, res) {
  if (!stripe) return res.status(503).send("Payments are not configured.");
  const signature = req.headers["stripe-signature"];
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET); }
  catch (error) { return res.status(400).send(`Webhook signature verification failed: ${error.message}`); }

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const checkout = event.data.object;
    const confirmedPaid = event.type === "checkout.session.async_payment_succeeded" || ["paid", "no_payment_required"].includes(checkout.payment_status);
    if (!confirmedPaid) return res.json({ received: true, pending: true });
    const vendorId = checkout.metadata?.vendorId;
    await db.collection("transactions").updateOne(
      { stripeSessionId: checkout.id },
      { $set: { vendorId, plan: "premium", planName: "Premium", amountCents: checkout.amount_total ?? null, currency: checkout.currency || "usd", status: "succeeded", paymentStatus: "paid", stripeSubscriptionId: checkout.subscription || null, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
    if (vendorId) await db.collection("user").updateOne({ _id: { $in: idOptions(vendorId) } }, { $set: { subscriptionPlan: "premium", plan: "premium", stripeCustomerId: checkout.customer || null, stripeSubscriptionId: checkout.subscription || null, updatedAt: new Date() } });
  } else if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
    const checkout = event.data.object;
    await db.collection("transactions").updateOne({ stripeSessionId: checkout.id }, { $set: { status: "failed", paymentStatus: "failed", updatedAt: new Date() } });
  } else if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    const vendorId = subscription.metadata?.vendorId;
    if (vendorId) await db.collection("user").updateOne({ _id: { $in: idOptions(vendorId) } }, { $set: { subscriptionPlan: "free", plan: "free", updatedAt: new Date() } });
  }
  res.json({ received: true });
}

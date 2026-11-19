import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URL?.trim();
if (!uri) throw new Error("MONGODB_URL must be set.");

const globalMongo = globalThis;
export const mongoClient = globalMongo.wedPlanMongoClient ?? new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
if (process.env.NODE_ENV !== "production") globalMongo.wedPlanMongoClient = mongoClient;
// Both Next.js and Express store Better Auth users/sessions in this database.
export const authDb = mongoClient.db("wedding_planning_platform");
export const db = mongoClient.db("wedding_planning_platform");
// console.log(`WedPlan connecting to MongoDB `);

export async function connectDatabase() {
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

function fromMinorUnits(amount, currency) {
  const code = String(currency || "USD").toUpperCase();
  const digits = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
  return Number((Number(amount || 0) / (10 ** digits)).toFixed(digits));
}

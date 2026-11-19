import { Router } from "express";
import { authDb, db } from "../config/database.js";
import { requireAdmin, requireUser } from "../middleware/auth.js";
import { asyncRoute } from "../utils/async-route.js";
import { escapeRegex, idOptions } from "../utils/ids.js";

export const adminRouter = Router();
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
    authDb.collection("user").find(filter).project({ name: 1, email: 1, role: 1, image: 1, blocked: 1, createdAt: 1, businessName: 1 }).sort({ createdAt: -1 }).skip((page - 1) * 20).limit(20).toArray(),
    authDb.collection("user").countDocuments(filter),
  ]);
  res.json({ users: list, total, page, limit: 20 });
}));

adminRouter.patch("/users/:id", asyncRoute(async (req, res) => {
  if (String(req.user.id) === String(req.params.id)) return res.status(400).json({ message: "You cannot block your own admin account." });
  if (typeof req.body?.blocked !== "boolean") return res.status(400).json({ message: "Provide blocked as true or false." });
  const user = await authDb.collection("user").findOneAndUpdate({ _id: { $in: idOptions(req.params.id) } }, { $set: { blocked: req.body.blocked, updatedAt: new Date() } }, { returnDocument: "after", projection: { name: 1, email: 1, role: 1, blocked: 1 } });
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
      const premium = ["premium", "pro"].includes(String(vendor?.subscriptionPlan || vendor?.plan || "").toLowerCase());
      if (!premium) {
        const activeCount = await db.collection("services").countDocuments({ vendorId: { $in: idOptions(vendorId) }, isActive: true, status: "approved", _id: { $ne: current._id } });
        if (activeCount >= 3) return res.status(409).json({ message: "This vendor has reached the Free plan limit of 3 active services." });
      }
    }
    update.status = req.body.status;
  }
  if (req.body?.isActive !== undefined) update.isActive = Boolean(req.body.isActive);
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
  const items = await db.collection("transactions").find({}).project({ vendorId: 1, vendor: 1, plan: 1, planName: 1, subscriptionPlan: 1, amount: 1, paymentAmount: 1, amountCents: 1, currency: 1, status: 1, paymentStatus: 1, createdAt: 1, transactionDate: 1 }).sort({ createdAt: -1 }).limit(300).toArray();
  res.json(await Promise.all(items.map(async (transaction) => {
    const vendor = transaction.vendorId ? await authDb.collection("user").findOne({ _id: { $in: idOptions(transaction.vendorId) } }, { projection: { name: 1, email: 1, businessName: 1 } }) : null;
    return { ...transaction, vendor: vendor || transaction.vendor };
  })));
}));

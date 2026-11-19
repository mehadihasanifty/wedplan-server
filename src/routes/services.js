import { Router } from "express";
import { authDb, db } from "../config/database.js";
import { optionalUser, requireRole, requireUser } from "../middleware/auth.js";
import { asyncRoute } from "../utils/async-route.js";
import { escapeRegex, idOptions } from "../utils/ids.js";

export const servicesRouter = Router();
const services = () => db.collection("services");
const users = () => authDb.collection("user");

servicesRouter.get("/", optionalUser, asyncRoute(async (req, res) => {
  const { search = "", category, location, sort = "", page = "1", limit = "100" } = req.query;
  const vendorRequested = Boolean(req.query.vendorId);
  if (vendorRequested && (!req.user || req.user.role !== "vendor")) return res.status(req.user ? 403 : 401).json({ message: "Sign in with a vendor account to view your services." });
  const filter = vendorRequested ? { vendorId: { $in: idOptions(req.user.id) } } : { status: "approved", isActive: true };
  if (category) filter.category = String(category).slice(0, 100);
  if (location) filter.location = { $regex: escapeRegex(String(location).slice(0, 100)), $options: "i" };
  const searchTerms = String(search).slice(0, 100).trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (searchTerms.length) {
    const searchableFields = ["serviceName", "category", "description", "location", "vendorName", "businessName", "vendor.name", "vendor.businessName"];
    filter.$and = await Promise.all(searchTerms.map(async (term) => {
      const expression = { $regex: escapeRegex(term), $options: "i" };
      const matchingVendors = await users().find({ $or: [{ name: expression }, { businessName: expression }] }, { projection: { _id: 1 } }).limit(100).toArray();
      const vendorIds = matchingVendors.flatMap((vendor) => idOptions(String(vendor._id)));
      const alternatives = searchableFields.map((field) => ({ [field]: expression }));
      if (vendorIds.length) alternatives.push({ vendorId: { $in: vendorIds } });
      return { $or: alternatives };
    }));
  }
  const take = Math.max(1, Math.min(Number(limit) || 100, 100));
  const currentPage = Math.max(1, Number(page) || 1);
  const sortSpec = ["low", "price-asc"].includes(String(sort)) ? { price: 1, _id: 1 } : ["high", "price-desc"].includes(String(sort)) ? { price: -1, _id: 1 } : { createdAt: -1, _id: -1 };
  const results = await services().find(filter).sort(sortSpec).skip((currentPage - 1) * take).limit(take).toArray();
  res.json(await Promise.all(results.map(enrichService)));
}));

servicesRouter.get("/:id", asyncRoute(async (req, res) => {
  const service = await services().findOne({ _id: { $in: idOptions(req.params.id) }, status: "approved", isActive: true });
  if (!service) return res.status(404).json({ message: "This service is not available." });
  res.json(await enrichService(service));
}));

servicesRouter.post("/", requireUser, requireRole("vendor"), asyncRoute(async (req, res) => {
  const input = validateService(req.body, true);
  if (input.error) return res.status(400).json({ message: input.error });
  const vendorId = String(req.user.id);
  const user = await users().findOne({ _id: { $in: idOptions(vendorId) } });
  const premium = ["premium", "pro"].includes(String(user?.subscriptionPlan || user?.plan || "").toLowerCase());
  if (!premium) {
    const activeCount = await services().countDocuments({ vendorId: { $in: idOptions(vendorId) }, isActive: true, status: "approved" });
    if (activeCount >= 3) return res.status(403).json({ message: "The free plan allows up to 3 active services. Upgrade to Premium to add more." });
  }
  const document = { ...input.value, vendorId, vendorName: req.user.name || "WedPlan vendor", status: "pending", isActive: true, createdAt: new Date(), updatedAt: new Date() };
  const result = await services().insertOne(document);
  res.status(201).json({ ...document, _id: result.insertedId });
}));

servicesRouter.patch("/:id", requireUser, requireRole("vendor"), asyncRoute(async (req, res) => {
  const input = validateService(req.body, false);
  if (input.error) return res.status(400).json({ message: input.error });
  const result = await services().findOneAndUpdate(
    { _id: { $in: idOptions(req.params.id) }, vendorId: { $in: idOptions(req.user.id) } },
    { $set: { ...input.value, status: "pending", updatedAt: new Date() } }, { returnDocument: "after" },
  );
  if (!result) return res.status(404).json({ message: "Service not found or not owned by your account." });
  res.json(result);
}));

servicesRouter.delete("/:id", requireUser, requireRole("vendor"), asyncRoute(async (req, res) => {
  const result = await services().deleteOne({ _id: { $in: idOptions(req.params.id) }, vendorId: { $in: idOptions(req.user.id) } });
  if (!result.deletedCount) return res.status(404).json({ message: "Service not found or not owned by your account." });
  res.status(204).end();
}));

async function enrichService(service) {
  const vendorId = service.vendorId ? String(service.vendorId) : "";
  const vendor = vendorId ? await users().findOne({ _id: { $in: idOptions(vendorId) } }, { projection: { name: 1, email: 1, image: 1, businessName: 1 } }) : null;
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
  const serviceImage = typeof body.serviceImage === "string" ? body.serviceImage.trim() : "";
  if (creating && (!serviceName || !category || !description || !location || !Number.isFinite(price) || price < 0 || (!serviceImage && !images.length))) {
    return { error: "Name, category, description, price, location, and at least one service image are required." };
  }
  const value = {};
  if (serviceName) value.serviceName = serviceName.slice(0, 120);
  if (category) value.category = category.slice(0, 100);
  if (description) value.description = description.slice(0, 5000);
  if (location) value.location = location.slice(0, 200);
  if (body.price !== undefined && Number.isFinite(price) && price >= 0) value.price = price;
  else if (body.price !== undefined) return { error: "Price must be a non-negative number." };
  if (body.images !== undefined) value.images = images;
  if (body.serviceImage !== undefined) value.serviceImage = serviceImage;
  if (body.currency) value.currency = String(body.currency).slice(0, 5);
  if (body.isActive !== undefined) value.isActive = Boolean(body.isActive);
  if (!creating && Object.keys(value).length === 0) return { error: "Provide at least one valid service field to update." };
  return { value };
}

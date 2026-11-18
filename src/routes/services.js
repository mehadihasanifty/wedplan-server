import { Router } from "express";
import { db } from "../config/database.js";
import { requireRole, requireUser } from "../middleware/auth.js";
import { asyncRoute } from "../utils/async-route.js";
import { escapeRegex, idOptions } from "../utils/ids.js";

export const servicesRouter = Router();
const services = () => db.collection("services");
const users = () => db.collection("user");

servicesRouter.get("/", asyncRoute(async (req, res) => {
  const { search = "", category, location, sort = "", page = "1", limit = "100" } = req.query;
  const filter = { status: "approved", isActive: true };
  if (category) filter.category = String(category).slice(0, 100);
  if (location) filter.location = { $regex: escapeRegex(String(location).slice(0, 100)), $options: "i" };
  if (search) filter.serviceName = { $regex: escapeRegex(String(search).slice(0, 100)), $options: "i" };
  const take = Math.max(1, Math.min(Number(limit) || 100, 100));
  const currentPage = Math.max(1, Number(page) || 1);
  const sortSpec = sort === "price-asc" ? { price: 1 } : sort === "price-desc" ? { price: -1 } : { createdAt: -1 };
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
    const activeCount = await services().countDocuments({ vendorId, isActive: true, status: "approved" });
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
  if (body.images !== undefined) value.images = images;
  if (body.serviceImage !== undefined) value.serviceImage = serviceImage;
  if (body.currency) value.currency = String(body.currency).slice(0, 5);
  if (body.isActive !== undefined) value.isActive = Boolean(body.isActive);
  return { value };
}

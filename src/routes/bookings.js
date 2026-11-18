import { Router } from "express";
import { db } from "../config/database.js";
import { requireRole, requireUser } from "../middleware/auth.js";
import { asyncRoute } from "../utils/async-route.js";
import { idOptions } from "../utils/ids.js";

export const bookingsRouter = Router();
const bookings = () => db.collection("bookings");

bookingsRouter.get("/", requireUser, requireRole("customer"), asyncRoute(async (req, res) => {
  const list = await bookings().find({ customerId: String(req.user.id) }).sort({ createdAt: -1 }).limit(100).toArray();
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
  const duplicate = await bookings().findOne({ serviceId: { $in: idOptions(serviceId) }, eventDate, status: { $in: ["pending", "accepted"] } });
  if (duplicate) return res.status(409).json({ message: "An active booking request already exists for this service and event date." });

  const [customer, vendor] = await Promise.all([
    db.collection("user").findOne({ _id: { $in: idOptions(req.user.id) } }, { projection: { name: 1, email: 1, image: 1 } }),
    db.collection("user").findOne({ _id: { $in: idOptions(vendorId) } }, { projection: { name: 1, email: 1, image: 1, businessName: 1 } }),
  ]);
  const booking = { serviceId, vendorId, customerId: String(req.user.id), eventDate, eventLocation, ...(message ? { message } : {}), status: "pending", createdAt: new Date(), updatedAt: new Date(), service: { ...service, vendor }, customer, vendor };
  try {
    const result = await bookings().insertOne(booking);
    res.status(201).json({ ...booking, _id: result.insertedId });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: "An active booking request already exists for this service and event date." });
    throw error;
  }
}));

bookingsRouter.get("/vendor", requireUser, requireRole("vendor"), asyncRoute(async (req, res) => {
  const list = await bookings().find({ vendorId: { $in: idOptions(req.user.id) } }).sort({ createdAt: -1 }).limit(100).toArray();
  res.json(await Promise.all(list.map(enrichBooking)));
}));

bookingsRouter.patch("/:id", requireUser, asyncRoute(async (req, res) => {
  const status = req.body?.status;
  const filter = { _id: { $in: idOptions(req.params.id) }, status: "pending" };
  if (req.user.role === "customer" && status === "cancelled") filter.customerId = String(req.user.id);
  else if (req.user.role === "vendor" && ["accepted", "rejected"].includes(status)) filter.vendorId = { $in: idOptions(req.user.id) };
  else return res.status(403).json({ message: "Your account cannot make this booking status change." });
  const result = await bookings().findOneAndUpdate(filter, { $set: { status, updatedAt: new Date() } }, { returnDocument: "after" });
  if (!result) return res.status(409).json({ message: "This booking is not yours or is no longer pending." });
  res.json(result);
}));

async function enrichBooking(booking) {
  const service = booking.serviceId ? await db.collection("services").findOne({ _id: { $in: idOptions(booking.serviceId) } }) : null;
  const customer = booking.customerId ? await db.collection("user").findOne({ _id: { $in: idOptions(booking.customerId) } }, { projection: { name: 1, email: 1, image: 1 } }) : null;
  const vendorId = booking.vendorId || service?.vendorId;
  const vendor = vendorId ? await db.collection("user").findOne({ _id: { $in: idOptions(vendorId) } }, { projection: { name: 1, email: 1, image: 1, businessName: 1 } }) : null;
  return { ...booking, service: service ? { ...service, vendor } : booking.service, customer: customer || booking.customer, vendor: vendor || booking.vendor };
}

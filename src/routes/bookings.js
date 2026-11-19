import { Router } from "express";
import { ObjectId } from "mongodb";
import { authDb, db } from "../config/database.js";
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
  const canonicalServiceId = service._id instanceof ObjectId ? service._id.toHexString() : String(service._id);
  const duplicate = await bookings().findOne({ serviceId: { $in: idOptions(canonicalServiceId) }, eventDate, status: { $in: ["pending", "accepted"] } });
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
    const previousBooking = previous?.bookingId ? await bookings().findOne({ _id: previous.bookingId, status: { $in: ["pending", "accepted"] } }) : null;
    const reservationStillLive = previous && !previous.bookingId && previous.expiresAt && previous.expiresAt > new Date();
    if (previousBooking || reservationStillLive || !previous) return res.status(409).json({ message: "An active booking request already exists for this service and event date." });
    await db.collection("bookingSlots").deleteOne({ _id: slotId, token: previous.token });
    try { await db.collection("bookingSlots").insertOne({ _id: slotId, token: reservationToken, expiresAt: new Date(Date.now() + 10 * 60 * 1000) }); }
    catch (retryError) { if (retryError?.code === 11000) return res.status(409).json({ message: "An active booking request already exists for this service and event date." }); throw retryError; }
  }

  const [customer, vendor] = await Promise.all([
    authDb.collection("user").findOne({ _id: { $in: idOptions(req.user.id) } }, { projection: { name: 1, email: 1, image: 1 } }),
    authDb.collection("user").findOne({ _id: { $in: idOptions(vendorId) } }, { projection: { name: 1, email: 1, image: 1, businessName: 1 } }),
  ]);
  const bookingId = new ObjectId();
  const booking = { _id: bookingId, serviceId: canonicalServiceId, vendorId, customerId: String(req.user.id), eventDate, eventLocation, ...(message ? { message } : {}), status: "pending", createdAt: new Date(), updatedAt: new Date(), service: { ...service, vendor }, customer, vendor };
  try {
    await bookings().insertOne(booking);
    await db.collection("bookingSlots").updateOne({ _id: slotId, token: reservationToken }, { $set: { bookingId, expiresAt: null } });
    res.status(201).json(booking);
  } catch (error) {
    await db.collection("bookingSlots").deleteOne({ _id: slotId, token: reservationToken });
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
  if (status === "cancelled" || status === "rejected") await db.collection("bookingSlots").deleteOne({ _id: `${result.serviceId}:${result.eventDate}` });
  res.json(result);
}));

async function enrichBooking(booking) {
  const service = booking.serviceId ? await db.collection("services").findOne({ _id: { $in: idOptions(booking.serviceId) } }) : null;
  const customer = booking.customerId ? await authDb.collection("user").findOne({ _id: { $in: idOptions(booking.customerId) } }, { projection: { name: 1, email: 1, image: 1 } }) : null;
  const vendorId = booking.vendorId || service?.vendorId;
  const vendor = vendorId ? await authDb.collection("user").findOne({ _id: { $in: idOptions(vendorId) } }, { projection: { name: 1, email: 1, image: 1, businessName: 1 } }) : null;
  return { ...booking, service: service ? { ...service, vendor } : booking.service, customer: customer || booking.customer, vendor: vendor || booking.vendor };
}

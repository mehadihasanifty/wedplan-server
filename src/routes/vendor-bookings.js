import { Router } from "express";
import { db } from "../config/database.js";
import { requireRole, requireUser } from "../middleware/auth.js";
import { asyncRoute } from "../utils/async-route.js";
import { idOptions } from "../utils/ids.js";

export const vendorBookingsRouter = Router();
vendorBookingsRouter.use(requireUser, requireRole("vendor"));

vendorBookingsRouter.get("/", asyncRoute(async (req, res) => {
  const list = await db.collection("bookings").find({ vendorId: { $in: idOptions(req.user.id) } }).sort({ createdAt: -1 }).limit(100).toArray();
  const enriched = await Promise.all(list.map(async (booking) => {
    const [service, customer] = await Promise.all([
      db.collection("services").findOne({ _id: { $in: idOptions(booking.serviceId) } }),
      db.collection("user").findOne({ _id: { $in: idOptions(booking.customerId) } }, { projection: { name: 1, email: 1, image: 1 } }),
    ]);
    return { ...booking, service: service || booking.service, customer: customer || booking.customer };
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

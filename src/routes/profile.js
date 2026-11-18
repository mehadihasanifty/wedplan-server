import { Router } from "express";
import { db } from "../config/database.js";
import { requireRole, requireUser } from "../middleware/auth.js";
import { asyncRoute } from "../utils/async-route.js";
import { idOptions } from "../utils/ids.js";

export const profileRouter = Router();

profileRouter.patch("/", requireUser, requireRole("vendor", "customer"), asyncRoute(async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return res.status(400).json({ message: "Provide profile fields as a JSON object." });
  const forbidden = ["role", "subscriptionPlan", "plan", "blocked", "stripeCustomerId", "stripeSubscriptionId"];
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
  for (const [key, max] of [["phoneNumber", 32], ["location", 120], ["bio", 500]]) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    if (typeof body[key] !== "string" || body[key].trim().length > max) return res.status(400).json({ message: `${key} must be ${max} characters or fewer.` });
    update[key] = body[key].trim();
  }
  if (!Object.keys(update).length) return res.status(400).json({ message: "No editable profile fields were provided." });
  update.updatedAt = new Date();

  const user = await db.collection("user").findOneAndUpdate(
    { _id: { $in: idOptions(req.user.id) } },
    { $set: update },
    { returnDocument: "after", projection: { name: 1, email: 1, image: 1, role: 1, phoneNumber: 1, location: 1, bio: 1, subscriptionPlan: 1, plan: 1 } },
  );
  if (!user) return res.status(404).json({ message: "Your account could not be found." });
  res.json({ profile: user, message: "Profile saved successfully." });
}));

function isAllowedImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch { return false; }
}

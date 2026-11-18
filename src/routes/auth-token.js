import { Router } from "express";
import { auth } from "../config/auth.js";
import { db } from "../config/database.js";
import { clearAccessTokenCookie, issueAccessToken, setAccessTokenCookie, verifyAccessToken } from "../middleware/auth.js";
import { idOptions } from "../utils/ids.js";

export const authTokenRouter = Router();

authTokenRouter.post("/token", async (request, response, next) => {
  try {
    const origin = request.get("origin");
    const allowed = (process.env.CLIENT_URL || "http://localhost:3000").split(",").map((item) => item.trim());
    if (origin && !allowed.includes(origin)) return response.status(403).json({ message: "This request origin is not allowed." });

    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(", "));
    }
    const session = await auth.api.getSession({ headers });
    if (!session) {
      clearAccessTokenCookie(response);
      return response.status(401).json({ message: "Sign in to establish an API session." });
    }

    const user = await db.collection("user").findOne({ _id: { $in: idOptions(session.user.id) } });
    if (!user || user.blocked === true) {
      clearAccessTokenCookie(response);
      return response.status(403).json({ message: "This account cannot access protected features." });
    }
    if (!["admin", "vendor", "customer"].includes(user.role)) return response.status(403).json({ message: "This account role is not authorized for WedPlan API access." });

    const token = issueAccessToken({ id: session.user.id, role: user.role, apiTokenVersion: user.apiTokenVersion });
    setAccessTokenCookie(response, token);
    response.set("Cache-Control", "no-store");
    return response.json({ authenticated: true, expiresIn: process.env.JWT_ACCESS_TTL?.trim() || "15m" });
  } catch (error) { next(error); }
});

authTokenRouter.delete("/token", async (request, response, next) => {
  try {
    const claims = verifyAccessToken(request);
    if (claims?.sub) await db.collection("user").updateOne({ _id: { $in: idOptions(claims.sub) } }, { $inc: { apiTokenVersion: 1 } });
  } catch (error) { return next(error); }
  clearAccessTokenCookie(response);
  response.set("Cache-Control", "no-store");
  response.status(204).end();
});

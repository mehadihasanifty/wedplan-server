import { auth } from "../config/auth.js";
import { db } from "../config/database.js";
import { idOptions } from "../utils/ids.js";

export async function optionalUser(request, response, next) {
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(", "));
    }
    const session = await auth.api.getSession({ headers });
    if (!session) return next();
    const user = await db.collection("user").findOne({ _id: { $in: idOptions(session.user.id) } });
    if (!user || user.blocked === true) return response.status(403).json({ message: "This account cannot access protected features." });
    request.user = { ...session.user, ...user, id: String(session.user.id), role: user.role || session.user.role || "customer" };
    request.authSession = session;
    next();
  } catch (error) { next(error); }
}

export function requireUser(request, response, next) {
  return optionalUser(request, response, (error) => {
    if (error) return next(error);
    if (!request.user) return response.status(401).json({ message: "Please sign in to continue." });
    next();
  });
}

export function requireRole(...roles) {
  return (request, response, next) => {
    if (!request.user) return response.status(401).json({ message: "Please sign in to continue." });
    if (!roles.includes(request.user.role)) return response.status(403).json({ message: "You do not have permission to perform this action." });
    next();
  };
}

export function requireAdmin(request, response, next) {
  return requireRole("admin")(request, response, next);
}

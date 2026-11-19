import jwt from "jsonwebtoken";
import { authDb } from "../config/database.js";
import { idOptions } from "../utils/ids.js";

const jwtSecret = process.env.JWT_SECRET?.trim();
if (!jwtSecret || Buffer.byteLength(jwtSecret) < 32) {
  throw new Error("JWT_SECRET must be set on the server and contain at least 32 bytes.");
}

const tokenCookie = "wedplan_access";
const issuer = "wedplan-server";
const audience = "wedplan-api";

export function issueAccessToken(user) {
  return jwt.sign({ role: user.role, ver: Number(user.apiTokenVersion) || 0 }, jwtSecret, {
    algorithm: "HS256", subject: String(user.id), issuer, audience,
    expiresIn: process.env.JWT_ACCESS_TTL?.trim() || "15m",
  });
}

export function setAccessTokenCookie(response, token) {
  const secure = process.env.NODE_ENV === "production";
  response.cookie(tokenCookie, token, {
    httpOnly: true,
    secure,
    sameSite: secure ? "none" : "lax",
    path: "/api",
    maxAge: 15 * 60 * 1000,
  });
}

export function clearAccessTokenCookie(response) {
  const secure = process.env.NODE_ENV === "production";
  response.clearCookie(tokenCookie, { httpOnly: true, secure, sameSite: secure ? "none" : "lax", path: "/api" });
}

function getToken(request) {
  try {
    const header = request.get("authorization") || "";
    if (/^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, "").trim();
    const cookieHeader = request.headers.cookie || "";
    for (const pair of cookieHeader.split(";")) {
      const [key, ...parts] = pair.trim().split("=");
      if (key === tokenCookie) return decodeURIComponent(parts.join("="));
    }
    return "";
  } catch { return ""; }
}

export function verifyAccessToken(request) {
  const token = getToken(request);
  if (!token) return null;
  try {
    const payload = jwt.verify(token, jwtSecret, { algorithms: ["HS256"], issuer, audience });
    // jsonwebtoken validates exp when it exists, but a signed token without an
    // exp claim would otherwise remain valid indefinitely. Access tokens must
    // always be time-limited and have a non-empty subject.
    if (!payload || typeof payload === "string" || typeof payload.sub !== "string" || !payload.sub.trim()) return null;
    if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

export async function optionalUser(request, response, next) {
  try {
    const claims = verifyAccessToken(request);
    if (!claims) return next();
    const user = await authDb.collection("user").findOne({ _id: { $in: idOptions(claims.sub) } });
    if (!user || user.isBlocked === true || user.blocked === true) return response.status(403).json({ message: "This account cannot access protected features." });
    if ((Number(claims.ver) || 0) !== (Number(user.apiTokenVersion) || 0)) return response.status(401).json({ message: "Your API session has been revoked. Sign in again to continue." });
    request.user = { ...user, id: String(claims.sub), role: user.role || claims.role || "customer" };
    request.authClaims = claims;
    next();
  } catch (error) { next(error); }
}

export function requireUser(request, response, next) {
  return optionalUser(request, response, (error) => {
    if (error) return next(error);
    if (!request.user) return response.status(401).json({ message: "Sign in again to continue. Your API session may have expired." });
    if (request.get("origin")) {
      const allowed = (process.env.CLIENT_URL || "http://localhost:3000").split(",").map((item) => item.trim());
      if (!allowed.includes(request.get("origin"))) return response.status(403).json({ message: "This request origin is not allowed." });
    }
    response.set("Cache-Control", "no-store");
    next();
  });
}

export function requireRole(...roles) {
  return (request, response, next) => {
    if (!request.user) return response.status(401).json({ message: "Sign in again to continue." });
    if (!roles.includes(request.user.role)) return response.status(403).json({ message: "You do not have permission to perform this action." });
    next();
  };
}

export function requireAdmin(request, response, next) {
  return requireRole("admin")(request, response, next);
}

export { tokenCookie };

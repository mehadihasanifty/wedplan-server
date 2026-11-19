import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { authDb, mongoClient } from "./database.js";

if (!process.env.BETTER_AUTH_SECRET?.trim()) {
  throw new Error("BETTER_AUTH_SECRET must match the WedPlan client secret so API requests can verify sessions.");
}

export const auth = betterAuth({
  appName: "WedPlan",
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET,
  database: mongodbAdapter(authDb, { client: mongoClient }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    // Match the client signup validation (6 characters plus upper/lowercase).
    minPasswordLength: 6,
  },
  user: { additionalFields: {
    role: { type: "string", required: false, defaultValue: "customer", input: true },
    businessName: { type: "string", required: false, input: true },
    isBlocked: { type: "boolean", required: false, defaultValue: false, input: false },
    subscriptionPlan: { type: "string", required: false, defaultValue: "free", input: false },
    subscriptionExpiresAt: { type: "date", required: false, input: false },
    phoneNumber: { type: "string", required: false, input: false },
    location: { type: "string", required: false, input: false },
    bio: { type: "string", required: false, input: false },
  } },
  databaseHooks: { user: {
    update: { before: async (user) => {
      if ("role" in user || "subscriptionPlan" in user || "subscriptionExpiresAt" in user || "isBlocked" in user || "blocked" in user) {
        throw new APIError("FORBIDDEN", { message: "Account role, access, and subscription settings cannot be changed from profile updates." });
      }
      return { data: user };
    } },
  } },
  ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? {
    socialProviders: { google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET } },
  } : {}),
});

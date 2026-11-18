import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { db, mongoClient } from "./database.js";

if (!process.env.BETTER_AUTH_SECRET?.trim()) {
  throw new Error("BETTER_AUTH_SECRET must match the WedPlan client secret so API requests can verify sessions.");
}

export const auth = betterAuth({
  appName: "WedPlan",
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET,
  database: mongodbAdapter(db, { client: mongoClient }),
  emailAndPassword: { enabled: true, requireEmailVerification: false },
  user: { additionalFields: {
    role: { type: "string", required: false, defaultValue: "customer", input: true },
    blocked: { type: "boolean", required: false, defaultValue: false, input: false },
    subscriptionPlan: { type: "string", required: false, defaultValue: "free", input: false },
  } },
  ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? {
    socialProviders: { google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET } },
  } : {}),
});

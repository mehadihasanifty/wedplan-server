import express from "express";
import cors from "cors";
import "dotenv/config";
import { connectDatabase } from "./config/database.js";
import { MongoClient } from 'mongodb';
import { getAllowedClientOrigins } from "./utils/origins.js";

const app = express();
const port = Number(process.env.PORT) || 5000;
const allowedOrigins = getAllowedClientOrigins();

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("This origin is not allowed by the API."));
  },
  credentials: true,
}));

// Stripe needs the original body bytes to verify its signature.
app.post("/api/payments/webhook", express.raw({ type: "application/json" }), async (request, response, next) => {
  try {
    const { handleStripeWebhook } = await import("./routes/payments.js");
    await handleStripeWebhook(request, response);
  } catch (error) { next(error); }
});
app.use(express.json({ limit: "2mb" }));

app.get("/", (_request, response) => {
  response.type("text/plain").send("WedPlan API server listening on");
});

app.get("/api/health", (_request, response) => response.json({ status: "ok", service: "wedplan-server" }));

try {
  // Connect first. Better Auth initializes MongoDB indexes when its route
  // modules load, so importing those modules before Mongo is ready causes
  // noisy MongoTopologyClosedError messages.
  await connectDatabase();
} catch (error) {
  console.error("WedPlan could not connect to MongoDB.");
  console.error("Check that MONGODB_URL is correct and that the database is running/reachable.");
  console.error(error.message);
  process.exit(1);
}

const [{ adminRouter }, { authTokenRouter }, { bookingsRouter }, { handleStripeWebhook, paymentsRouter }, { profileRouter }, { servicesRouter }, { vendorBookingsRouter }] = await Promise.all([
  import("./routes/admin.js"),
  import("./routes/auth-token.js"),
  import("./routes/bookings.js"),
  import("./routes/payments.js"),
  import("./routes/profile.js"),
  import("./routes/services.js"),
  import("./routes/vendor-bookings.js"),
]);

app.use("/api/services", servicesRouter);
app.use("/api/bookings", bookingsRouter);
app.use("/api/vendor/bookings", vendorBookingsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/auth", authTokenRouter);
app.use("/api/profile", profileRouter);
app.use("/api/payments", paymentsRouter);

app.use((_request, response) => response.status(404).json({ message: "API endpoint not found." }));
app.use((error, _request, response, _next) => {
  console.error("WedPlan API error:", error);
  if (response.headersSent) return;
  const parserError = error?.type === "entity.parse.failed";
  const duplicateError = error?.code === 11000;
  const candidateStatus = Number(error?.status ?? error?.statusCode);
  const status = parserError ? 400 : duplicateError ? 409 : Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus <= 599 ? candidateStatus : 500;
  const message = parserError
    ? "Request body must contain valid JSON."
    : duplicateError
      ? "A record with these details already exists."
      : status < 500 && typeof error?.message === "string"
        ? error.message
        : "An unexpected server error occurred. Please try again.";
  response.status(status).json({ message });
});

app.listen(port, () => console.log(`WedPlan API server listening on`));

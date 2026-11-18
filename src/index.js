import "dotenv/config";
import cors from "cors";
import express from "express";
import { connectDatabase } from "./config/database.js";
import { adminRouter } from "./routes/admin.js";
import { bookingsRouter } from "./routes/bookings.js";
import { handleStripeWebhook, paymentsRouter } from "./routes/payments.js";
import { servicesRouter } from "./routes/services.js";
import { vendorBookingsRouter } from "./routes/vendor-bookings.js";

const app = express();
const port = Number(process.env.PORT) || 5000;
const allowedOrigins = (process.env.CLIENT_URL || "http://localhost:3000").split(",").map((origin) => origin.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("This origin is not allowed by the API."));
  },
  credentials: true,
}));

// Stripe requires the unparsed request body to verify webhook signatures.
app.post("/api/payments/webhook", express.raw({ type: "application/json" }), handleStripeWebhook);
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_request, response) => response.json({ status: "ok", service: "wedplan-server" }));
app.use("/api/services", servicesRouter);
app.use("/api/bookings", bookingsRouter);
app.use("/api/vendor/bookings", vendorBookingsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/payments", paymentsRouter);

app.use((_request, response) => response.status(404).json({ message: "API endpoint not found." }));
app.use((error, _request, response, _next) => {
  console.error("WedPlan API error:", error);
  if (response.headersSent) return;
  response.status(error.status || error.statusCode || 500).json({ message: error.status ? error.message : "An unexpected server error occurred." });
});

await connectDatabase();
app.listen(port, () => console.log(`WedPlan API server listening on http://localhost:${port}`));

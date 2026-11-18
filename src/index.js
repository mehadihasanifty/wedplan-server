import "dotenv/config";
import cors from "cors";
import express from "express";

const app = express();
const port = Number(process.env.PORT) || 5000;
const allowedOrigins = (process.env.CLIENT_URL || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser clients such as curl and server-to-server requests.
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("This origin is not allowed by the API."));
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok", service: "wedplan-server" });
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ message: "An unexpected server error occurred." });
});

app.listen(port, () => {
  console.log(`WedPlan API server listening on http://localhost:${port}`);
});

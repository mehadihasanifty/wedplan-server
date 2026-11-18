import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URL?.trim();
if (!uri) throw new Error("MONGODB_URL must be set.");

const globalMongo = globalThis;
export const mongoClient = globalMongo.wedPlanMongoClient ?? new MongoClient(uri);
if (process.env.NODE_ENV !== "production") globalMongo.wedPlanMongoClient = mongoClient;
export const db = mongoClient.db();

export async function connectDatabase() {
  await mongoClient.connect();
  await db.command({ ping: 1 });
  await db.collection("bookingSlots").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "booking_slot_expiry" });
}

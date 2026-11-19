import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URL?.trim();
if (!uri) throw new Error("MONGODB_URL must be set.");

const globalMongo = globalThis;
export const mongoClient = globalMongo.wedPlanMongoClient ?? new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
if (process.env.NODE_ENV !== "production") globalMongo.wedPlanMongoClient = mongoClient;
// Both Next.js and Express store Better Auth users/sessions in this database.
export const authDb = mongoClient.db("wedding_planning_platform");
export const db = mongoClient.db("wedding_planning_platform");
// console.log(`WedPlan connecting to MongoDB `);

export async function connectDatabase() {
  await mongoClient.connect();
  await authDb.command({ ping: 1 });
  await db.command({ ping: 1 });
  await db.collection("bookingSlots").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "booking_slot_expiry" });
}

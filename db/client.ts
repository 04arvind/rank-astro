import { MongoClient, type Db } from "mongodb";
import { ConfigurationError, DatabaseError } from "@/lib/errors";

/*
 * One MongoClient per process, kept on globalThis so dev hot reloads reuse
 * the pool instead of opening a new one per edit. Reads MONGO_URI (and the
 * optional MONGO_DB_NAME) from the environment; a failed connect is not
 * cached, so the next call retries.
 */

const DEFAULT_DB_NAME = "rank_astro";

const g = globalThis as unknown as { __mongo?: Promise<MongoClient> };

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.MONGO_URI?.trim());
}

/** Database name: MONGO_DB_NAME, else the URI's path (`…/name?…`), else "rank_astro". */
export function databaseName(uri = process.env.MONGO_URI ?? ""): string {
  const fromEnv = process.env.MONGO_DB_NAME?.trim();
  if (fromEnv) return fromEnv;
  const fromUri = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/)?.[1];
  return fromUri ? decodeURIComponent(fromUri) : DEFAULT_DB_NAME;
}

async function connect(uri: string): Promise<MongoClient> {
  // ignoreUndefined: optional fields stay absent instead of being stored as null.
  const client = new MongoClient(uri, { appName: "rank_astro", serverSelectionTimeoutMS: 5000, ignoreUndefined: true });
  try {
    await client.connect();
    return client;
  } catch (err) {
    await client.close().catch(() => {});
    // The URI can hold credentials, so it never goes into error details.
    throw new DatabaseError("Could not connect to MongoDB", { operation: "connect" }, { cause: err });
  }
}

export async function getMongoClient(): Promise<MongoClient> {
  const uri = process.env.MONGO_URI?.trim();
  if (!uri) throw new ConfigurationError("MONGO_URI is not set");
  if (!g.__mongo) {
    g.__mongo = connect(uri);
    g.__mongo.catch(() => {
      g.__mongo = undefined;
    });
  }
  return g.__mongo;
}

export async function getDb(): Promise<Db> {
  return (await getMongoClient()).db(databaseName());
}

/** Closes the shared client (scripts, tests). */
export async function closeDb(): Promise<void> {
  const pending = g.__mongo;
  g.__mongo = undefined;
  if (pending) await (await pending.catch(() => null))?.close();
}

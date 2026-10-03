// Polyfill for Bun's process.getBuiltinModule('v8') to support BSON v7 in Bun runtime
if (typeof process !== "undefined" && typeof (process as any).getBuiltinModule === "function") {
  const orig = (process as any).getBuiltinModule;
  (process as any).getBuiltinModule = function (mod: string) {
    if (mod === "v8") {
      const v8 = orig.call(process, mod);
      return {
        ...v8,
        startupSnapshot: {
          isBuildingSnapshot: () => false,
        },
      };
    }
    return orig.call(process, mod);
  };
}

import dns from "node:dns";

// Configure public DNS resolvers to handle SRV lookups if local ISP DNS refuses SRV queries
try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch {
  // Ignore in environments where setServers is restricted
}

import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI?.trim();

/**
 * Expands a mongodb+srv:// URI into a standard mongodb:// one using a dedicated resolver on public DNS.
 * dns.setServers() above doesn't reach dns.promises (what the driver uses) in every runtime, so ISP
 * resolvers that refuse SRV queries would otherwise still break the connection.
 */
async function expandSrvUri(uri: string): Promise<string> {
  if (!uri.startsWith("mongodb+srv://")) return uri;
  try {
    const url = new URL(uri);
    const resolver = new dns.promises.Resolver();
    resolver.setServers(["8.8.8.8", "1.1.1.1"]);

    const [srv, txt] = await Promise.all([
      resolver.resolveSrv(`_mongodb._tcp.${url.hostname}`),
      resolver.resolveTxt(url.hostname).catch(() => [] as string[][]),
    ]);

    const hosts = srv.map((r) => `${r.name}:${r.port}`).join(",");
    const params = new URLSearchParams(txt.flat().join("&"));
    params.set("tls", "true");
    url.searchParams.forEach((value, key) => params.set(key, value));

    const auth = url.username
      ? `${url.username}${url.password ? `:${url.password}` : ""}@`
      : "";
    return `mongodb://${auth}${hosts}${url.pathname}?${params.toString()}`;
  } catch {
    return uri; // let the driver surface its own error
  }
}

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

// Global cached connection for Next.js hot-reloading
const globalForMongoose = globalThis as unknown as {
  mongooseCache?: MongooseCache;
};

const cached: MongooseCache = globalForMongoose.mongooseCache || {
  conn: null,
  promise: null,
};

globalForMongoose.mongooseCache = cached;

export async function connectToDatabase(): Promise<typeof mongoose | null> {
  if (!MONGODB_URI) {
    console.warn("[MongoDB] MONGODB_URI is not defined in environment variables. Falling back to in-memory/file store.");
    return null;
  }

  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    const opts: mongoose.ConnectOptions = {
      bufferCommands: false,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    };

    cached.promise = expandSrvUri(MONGODB_URI)
      .then((uri) => mongoose.connect(uri, opts))
      .then((m) => {
        console.log("[MongoDB] Connected successfully to MongoDB Atlas.");
        return m;
      })
      .catch((err) => {
        console.warn("[MongoDB] Connection warning (falling back to local store):", err?.message || err);
        cached.promise = null;
        return null as any;
      });
  }

  try {
    cached.conn = await cached.promise;
    return cached.conn;
  } catch (e) {
    cached.promise = null;
    return null;
  }
}

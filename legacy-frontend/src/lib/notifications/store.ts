import fs from "fs";
import path from "path";
import { VaultNotificationSubscription, AlertLogEntry, AlertThreshold } from "@/types/notifications";
import { connectToDatabase } from "@/lib/db/mongodb";
import { VaultSubscriptionModel, IVaultSubscription } from "@/lib/db/models/VaultSubscription";

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE_FILE = path.join(DATA_DIR, "subscriptions.json");

// In-memory fallback
const memoryCache = new Map<string, VaultNotificationSubscription>();

function ensureDirExists() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch (err) {
    console.warn("[Store] Unable to create data directory:", err);
  }
}

function loadFromFile(): void {
  try {
    ensureDirExists();
    if (fs.existsSync(STORE_FILE)) {
      const raw = fs.readFileSync(STORE_FILE, "utf-8");
      const list: VaultNotificationSubscription[] = JSON.parse(raw);
      for (const item of list) {
        if (item.vaultAddress) {
          memoryCache.set(item.vaultAddress.toLowerCase(), item);
        }
      }
    }
  } catch (err) {
    console.warn("[Store] Failed to load from file:", err);
  }
}

function persistToFile(): void {
  try {
    ensureDirExists();
    const list = Array.from(memoryCache.values());
    fs.writeFileSync(STORE_FILE, JSON.stringify(list, null, 2), "utf-8");
  } catch (err) {
    console.warn("[Store] Failed to persist to file:", err);
  }
}

// Initial load
loadFromFile();

function docToSubscription(doc: IVaultSubscription): VaultNotificationSubscription {
  return {
    vaultAddress: doc.vaultAddress as `0x${string}`,
    ownerAddress: doc.ownerAddress as `0x${string}`,
    email: doc.email,
    emailVerified: doc.emailVerified,
    pushEnabled: doc.pushEnabled,
    createdAt: doc.createdAt ? new Date(doc.createdAt).getTime() : Date.now(),
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).getTime() : Date.now(),
    lastAlertSent: doc.lastAlertSent
      ? {
          threshold: doc.lastAlertSent.threshold,
          timestamp: doc.lastAlertSent.timestamp,
          cycleEpoch: doc.lastAlertSent.cycleEpoch,
        }
      : undefined,
    lastClaimAlertSent: doc.lastClaimAlertSent
      ? {
          threshold: doc.lastClaimAlertSent.threshold,
          timestamp: doc.lastClaimAlertSent.timestamp,
          claimInitiatedAt: doc.lastClaimAlertSent.claimInitiatedAt,
          heirAddress: doc.lastClaimAlertSent.heirAddress as `0x${string}`,
        }
      : undefined,
    lastFundingAlert: doc.lastFundingAlert
      ? {
          fingerprint: doc.lastFundingAlert.fingerprint,
          timestamp: doc.lastFundingAlert.timestamp,
        }
      : undefined,
    recentAlerts: (doc.recentAlerts || []).map((a) => ({
      id: a.id,
      threshold: a.threshold,
      title: a.title,
      message: a.message,
      timestamp: a.timestamp,
      channel: (a.channel as any) || "email",
      success: a.success,
      error: a.error,
    })),
  };
}

export async function getSubscription(vaultAddress: string): Promise<VaultNotificationSubscription | null> {
  const key = vaultAddress.toLowerCase();

  try {
    const conn = await connectToDatabase();
    if (conn) {
      const doc = await VaultSubscriptionModel.findOne({ vaultAddress: key });
      if (doc) {
        const sub = docToSubscription(doc);
        memoryCache.set(key, sub);
        return sub;
      }
      return null;
    }
  } catch (err) {
    console.warn("[Store] Mongo query failed, falling back to cache:", err);
  }

  loadFromFile();
  return memoryCache.get(key) || null;
}

export async function getAllSubscriptions(): Promise<VaultNotificationSubscription[]> {
  try {
    const conn = await connectToDatabase();
    if (conn) {
      const docs = await VaultSubscriptionModel.find({});
      const list = docs.map(docToSubscription);
      for (const item of list) {
        memoryCache.set(item.vaultAddress.toLowerCase(), item);
      }
      return list;
    }
  } catch (err) {
    console.warn("[Store] Mongo getAll failed, falling back to cache:", err);
  }

  loadFromFile();
  return Array.from(memoryCache.values());
}

export async function saveSubscription(
  sub: Partial<VaultNotificationSubscription> & { vaultAddress: `0x${string}`; ownerAddress: `0x${string}` }
): Promise<VaultNotificationSubscription> {
  const key = sub.vaultAddress.toLowerCase();

  try {
    const conn = await connectToDatabase();
    if (conn) {
      const updateData: Record<string, unknown> = {
        vaultAddress: key,
        ownerAddress: sub.ownerAddress.toLowerCase(),
      };
      if (sub.email !== undefined) updateData.email = sub.email.toLowerCase().trim();
      if (sub.emailVerified !== undefined) updateData.emailVerified = sub.emailVerified;
      if (sub.pushEnabled !== undefined) updateData.pushEnabled = sub.pushEnabled;
      if (sub.lastAlertSent !== undefined) updateData.lastAlertSent = sub.lastAlertSent;

      const doc = await VaultSubscriptionModel.findOneAndUpdate(
        { vaultAddress: key },
        { $set: updateData },
        { new: true, upsert: true }
      );

      const updated = docToSubscription(doc);
      memoryCache.set(key, updated);
      persistToFile();
      return updated;
    }
  } catch (err) {
    console.warn("[Store] Mongo save failed, falling back to file:", err);
  }

  // Fallback to memory/file
  loadFromFile();
  const existing = memoryCache.get(key);
  const updated: VaultNotificationSubscription = {
    vaultAddress: sub.vaultAddress,
    ownerAddress: sub.ownerAddress,
    email: sub.email ?? existing?.email,
    emailVerified: sub.emailVerified ?? existing?.emailVerified ?? false,
    pushEnabled: sub.pushEnabled ?? existing?.pushEnabled ?? false,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    lastAlertSent: sub.lastAlertSent ?? existing?.lastAlertSent,
    recentAlerts: sub.recentAlerts ?? existing?.recentAlerts ?? [],
  };

  memoryCache.set(key, updated);
  persistToFile();
  return updated;
}

export async function recordAlertLog(
  vaultAddress: string,
  entry: Omit<AlertLogEntry, "id" | "timestamp">
): Promise<AlertLogEntry> {
  const key = vaultAddress.toLowerCase();
  const logItem: AlertLogEntry = {
    ...entry,
    id: `alert_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    timestamp: Date.now(),
  };

  try {
    const conn = await connectToDatabase();
    if (conn) {
      await VaultSubscriptionModel.updateOne(
        { vaultAddress: key },
        {
          $push: {
            recentAlerts: {
              $each: [logItem],
              $position: 0,
              $slice: 20, // keep max 20 entries
            },
          },
        }
      );
    }
  } catch (err) {
    console.warn("[Store] Mongo recordAlertLog failed:", err);
  }

  loadFromFile();
  const existing = memoryCache.get(key);
  if (existing) {
    const list = existing.recentAlerts || [];
    existing.recentAlerts = [logItem, ...list].slice(0, 20);
    existing.updatedAt = Date.now();
    memoryCache.set(key, existing);
    persistToFile();
  }

  return logItem;
}

export async function updateLastAlert(
  vaultAddress: string,
  threshold: AlertThreshold,
  cycleEpoch: number
): Promise<void> {
  const key = vaultAddress.toLowerCase();
  const alertMeta = {
    threshold,
    timestamp: Date.now(),
    cycleEpoch,
  };

  try {
    const conn = await connectToDatabase();
    if (conn) {
      await VaultSubscriptionModel.updateOne(
        { vaultAddress: key },
        { $set: { lastAlertSent: alertMeta } }
      );
    }
  } catch (err) {
    console.warn("[Store] Mongo updateLastAlert failed:", err);
  }

  loadFromFile();
  const existing = memoryCache.get(key);
  if (existing) {
    existing.lastAlertSent = alertMeta;
    existing.updatedAt = Date.now();
    memoryCache.set(key, existing);
    persistToFile();
  }
}

export async function updateLastClaimAlert(
  vaultAddress: string,
  threshold: AlertThreshold,
  claimInitiatedAt: number,
  heirAddress: string
): Promise<void> {
  const key = vaultAddress.toLowerCase();
  const claimAlertMeta = {
    threshold,
    timestamp: Date.now(),
    claimInitiatedAt,
    heirAddress: heirAddress.toLowerCase(),
  };

  try {
    const conn = await connectToDatabase();
    if (conn) {
      await VaultSubscriptionModel.updateOne(
        { vaultAddress: key },
        { $set: { lastClaimAlertSent: claimAlertMeta } }
      );
    }
  } catch (err) {
    console.warn("[Store] Mongo updateLastClaimAlert failed:", err);
  }

  loadFromFile();
  const existing = memoryCache.get(key);
  if (existing) {
    existing.lastClaimAlertSent = {
      threshold,
      timestamp: Date.now(),
      claimInitiatedAt,
      heirAddress: heirAddress.toLowerCase() as `0x${string}`,
    };
    existing.updatedAt = Date.now();
    memoryCache.set(key, existing);
    persistToFile();
  }
}

export async function updateLastFundingAlert(
  vaultAddress: string,
  fingerprint: string
): Promise<void> {
  const key = vaultAddress.toLowerCase();
  const alertMeta = {
    fingerprint,
    timestamp: Date.now(),
  };

  try {
    const conn = await connectToDatabase();
    if (conn) {
      await VaultSubscriptionModel.updateOne(
        { vaultAddress: key },
        { $set: { lastFundingAlert: alertMeta } }
      );
    }
  } catch (err) {
    console.warn("[Store] Mongo updateLastFundingAlert failed:", err);
  }

  loadFromFile();
  const existing = memoryCache.get(key);
  if (existing) {
    existing.lastFundingAlert = alertMeta;
    existing.updatedAt = Date.now();
    memoryCache.set(key, existing);
    persistToFile();
  }
}


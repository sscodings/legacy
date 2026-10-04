import fs from "fs";
import path from "path";
import { connectToDatabase } from "@/lib/db/mongodb";
import { SealedInheritanceModel, ISealedInheritance } from "@/lib/db/models/SealedInheritance";
import type { SealedBundle, SealedVideoMeta } from "./crypto";

export interface SealedInheritanceRecord {
  vaultAddress: string;
  heirAddress: string;
  heirPublicKey: string;
  keyScheme?: "wallet-signature" | "passkey-prf";
  credentialId?: string;
  sealedForPublicKey?: string;
  sealedVideoForPublicKey?: string;
  sealedBundle?: SealedBundle;
  sealedBy?: string;
  sealedAt?: number;
  sealedVideo?: SealedVideoMeta;
  sealedVideoBy?: string;
  sealedVideoAt?: number;
}

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE_FILE = path.join(DATA_DIR, "sealed-inheritance.json");

const memoryCache = new Map<string, SealedInheritanceRecord>();

function keyFor(vault: string, heir: string): string {
  return `${vault.toLowerCase()}:${heir.toLowerCase()}`;
}

function ensureDirExists() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.warn("[Inheritance] Unable to create data directory:", err);
  }
}

function loadFromFile(): void {
  try {
    ensureDirExists();
    if (fs.existsSync(STORE_FILE)) {
      const raw = fs.readFileSync(STORE_FILE, "utf-8");
      const list: SealedInheritanceRecord[] = JSON.parse(raw);
      for (const item of list) {
        if (item.vaultAddress && item.heirAddress) {
          memoryCache.set(keyFor(item.vaultAddress, item.heirAddress), item);
        }
      }
    }
  } catch (err) {
    console.warn("[Inheritance] Failed to load from file:", err);
  }
}

function persistToFile(): void {
  try {
    ensureDirExists();
    fs.writeFileSync(STORE_FILE, JSON.stringify(Array.from(memoryCache.values()), null, 2), "utf-8");
  } catch (err) {
    console.warn("[Inheritance] Failed to persist to file:", err);
  }
}

loadFromFile();

function docToRecord(doc: ISealedInheritance): SealedInheritanceRecord {
  return {
    vaultAddress: doc.vaultAddress,
    heirAddress: doc.heirAddress,
    heirPublicKey: doc.heirPublicKey,
    keyScheme: doc.keyScheme || "wallet-signature",
    credentialId: doc.credentialId,
    sealedForPublicKey: doc.sealedForPublicKey,
    sealedVideoForPublicKey: doc.sealedVideoForPublicKey,
    sealedBundle: doc.sealedBundle
      ? { ephPub: doc.sealedBundle.ephPub, nonce: doc.sealedBundle.nonce, ct: doc.sealedBundle.ct }
      : undefined,
    sealedBy: doc.sealedBy,
    sealedAt: doc.sealedAt,
    sealedVideo: doc.sealedVideo
      ? {
          ephPub: doc.sealedVideo.ephPub,
          nonce: doc.sealedVideo.nonce,
          blobUrl: doc.sealedVideo.blobUrl,
          ciphertextHash: doc.sealedVideo.ciphertextHash,
          mimeType: doc.sealedVideo.mimeType,
          size: doc.sealedVideo.size,
        }
      : undefined,
    sealedVideoBy: doc.sealedVideoBy,
    sealedVideoAt: doc.sealedVideoAt,
  };
}

export async function getInheritance(
  vault: string,
  heir: string
): Promise<SealedInheritanceRecord | null> {
  const key = keyFor(vault, heir);
  try {
    const conn = await connectToDatabase();
    if (conn) {
      const doc = await SealedInheritanceModel.findOne({
        vaultAddress: vault.toLowerCase(),
        heirAddress: heir.toLowerCase(),
      });
      if (doc) {
        const rec = docToRecord(doc);
        memoryCache.set(key, rec);
        return rec;
      }
      return null;
    }
  } catch (err) {
    console.warn("[Inheritance] Mongo query failed, falling back to cache:", err);
  }
  loadFromFile();
  return memoryCache.get(key) || null;
}

/** Create or update the heir's published public key (enrollment). */
export async function saveEnrollment(
  vault: string,
  heir: string,
  heirPublicKey: string,
  keyScheme: "wallet-signature" | "passkey-prf" = "wallet-signature",
  credentialId?: string
): Promise<SealedInheritanceRecord> {
  const key = keyFor(vault, heir);
  try {
    const conn = await connectToDatabase();
    if (conn) {
      const updateData: Record<string, unknown> = { heirPublicKey, keyScheme };
      if (credentialId) {
        updateData.credentialId = credentialId;
      }
      const doc = await SealedInheritanceModel.findOneAndUpdate(
        { vaultAddress: vault.toLowerCase(), heirAddress: heir.toLowerCase() },
        { $set: updateData },
        { new: true, upsert: true }
      );
      const rec = docToRecord(doc);
      memoryCache.set(key, rec);
      persistToFile();
      return rec;
    }
  } catch (err) {
    console.warn("[Inheritance] Mongo enrollment save failed, falling back to file:", err);
  }
  loadFromFile();
  const existing = memoryCache.get(key);
  const rec: SealedInheritanceRecord = {
    vaultAddress: vault.toLowerCase(),
    heirAddress: heir.toLowerCase(),
    heirPublicKey,
    keyScheme,
    credentialId: credentialId || existing?.credentialId,
    sealedForPublicKey: existing?.sealedForPublicKey,
    sealedVideoForPublicKey: existing?.sealedVideoForPublicKey,
    sealedBundle: existing?.sealedBundle,
    sealedBy: existing?.sealedBy,
    sealedAt: existing?.sealedAt,
    sealedVideo: existing?.sealedVideo,
    sealedVideoBy: existing?.sealedVideoBy,
    sealedVideoAt: existing?.sealedVideoAt,
  };
  memoryCache.set(key, rec);
  persistToFile();
  return rec;
}

/** Store the owner's sealed bundle for an already-enrolled heir. */
export async function saveSealedBundle(
  vault: string,
  heir: string,
  bundle: SealedBundle,
  sealedBy: string,
  sealedForPublicKey?: string
): Promise<SealedInheritanceRecord | null> {
  const key = keyFor(vault, heir);
  const sealedAt = Date.now();
  try {
    const conn = await connectToDatabase();
    if (conn) {
      const updateData: Record<string, unknown> = {
        sealedBundle: bundle,
        sealedBy: sealedBy.toLowerCase(),
        sealedAt,
      };
      if (sealedForPublicKey) {
        updateData.sealedForPublicKey = sealedForPublicKey;
      }
      const doc = await SealedInheritanceModel.findOneAndUpdate(
        { vaultAddress: vault.toLowerCase(), heirAddress: heir.toLowerCase() },
        { $set: updateData },
        { new: true }
      );
      if (!doc) return null;
      const rec = docToRecord(doc);
      memoryCache.set(key, rec);
      persistToFile();
      return rec;
    }
  } catch (err) {
    console.warn("[Inheritance] Mongo seal save failed, falling back to file:", err);
  }
  loadFromFile();
  const existing = memoryCache.get(key);
  if (!existing) return null;
  const rec: SealedInheritanceRecord = {
    ...existing,
    sealedBundle: bundle,
    sealedBy: sealedBy.toLowerCase(),
    sealedAt,
    sealedForPublicKey: sealedForPublicKey || existing.sealedForPublicKey,
  };
  memoryCache.set(key, rec);
  persistToFile();
  return rec;
}

/** Store the owner's sealed video metadata for an already-enrolled heir. The
 *  ciphertext itself lives in blob storage; only its URL + digest are kept here. */
export async function saveSealedVideo(
  vault: string,
  heir: string,
  video: SealedVideoMeta,
  sealedBy: string,
  sealedVideoForPublicKey?: string
): Promise<SealedInheritanceRecord | null> {
  const key = keyFor(vault, heir);
  const sealedVideoAt = Date.now();
  try {
    const conn = await connectToDatabase();
    if (conn) {
      const updateData: Record<string, unknown> = {
        sealedVideo: video,
        sealedVideoBy: sealedBy.toLowerCase(),
        sealedVideoAt,
      };
      if (sealedVideoForPublicKey) {
        updateData.sealedVideoForPublicKey = sealedVideoForPublicKey;
      }
      const doc = await SealedInheritanceModel.findOneAndUpdate(
        { vaultAddress: vault.toLowerCase(), heirAddress: heir.toLowerCase() },
        { $set: updateData },
        { new: true }
      );
      if (!doc) return null;
      const rec = docToRecord(doc);
      memoryCache.set(key, rec);
      persistToFile();
      return rec;
    }
  } catch (err) {
    console.warn("[Inheritance] Mongo video save failed, falling back to file:", err);
  }
  loadFromFile();
  const existing = memoryCache.get(key);
  if (!existing) return null;
  const rec: SealedInheritanceRecord = {
    ...existing,
    sealedVideo: video,
    sealedVideoBy: sealedBy.toLowerCase(),
    sealedVideoAt,
    sealedVideoForPublicKey: sealedVideoForPublicKey || existing.sealedVideoForPublicKey,
  };
  memoryCache.set(key, rec);
  persistToFile();
  return rec;
}

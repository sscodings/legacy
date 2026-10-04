import mongoose, { Schema, Document, Model } from "mongoose";

export interface ISealedBundle {
  ephPub: string;
  nonce: string;
  ct: string;
}

/** A sealed video's ciphertext lives in blob storage; only its metadata is stored here. */
export interface ISealedVideo {
  ephPub: string;
  nonce: string;
  blobUrl: string;
  ciphertextHash: string;
  mimeType: string;
  size: number;
}

export interface ISealedInheritance extends Document {
  vaultAddress: string;
  heirAddress: string;
  heirPublicKey: string;
  keyScheme?: "wallet-signature" | "passkey-prf";
  credentialId?: string;
  sealedForPublicKey?: string;
  sealedVideoForPublicKey?: string;
  sealedBundle?: ISealedBundle;
  sealedBy?: string;
  sealedAt?: number;
  sealedVideo?: ISealedVideo;
  sealedVideoBy?: string;
  sealedVideoAt?: number;
  createdAt: Date;
  updatedAt: Date;
}

const SealedBundleSchema = new Schema<ISealedBundle>(
  {
    ephPub: { type: String, required: true },
    nonce: { type: String, required: true },
    ct: { type: String, required: true },
  },
  { _id: false }
);

const SealedVideoSchema = new Schema<ISealedVideo>(
  {
    ephPub: { type: String, required: true },
    nonce: { type: String, required: true },
    blobUrl: { type: String, required: true },
    ciphertextHash: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
  },
  { _id: false }
);

const SealedInheritanceSchema = new Schema<ISealedInheritance>(
  {
    vaultAddress: { type: String, required: true, lowercase: true, trim: true, index: true },
    heirAddress: { type: String, required: true, lowercase: true, trim: true, index: true },
    heirPublicKey: { type: String, required: true },
    keyScheme: { type: String, enum: ["wallet-signature", "passkey-prf"], default: "wallet-signature" },
    credentialId: { type: String },
    sealedForPublicKey: { type: String },
    sealedVideoForPublicKey: { type: String },
    sealedBundle: { type: SealedBundleSchema },
    sealedBy: { type: String, lowercase: true, trim: true },
    sealedAt: { type: Number },
    sealedVideo: { type: SealedVideoSchema },
    sealedVideoBy: { type: String, lowercase: true, trim: true },
    sealedVideoAt: { type: Number },
  },
  { timestamps: true }
);

SealedInheritanceSchema.index({ vaultAddress: 1, heirAddress: 1 }, { unique: true });

export const SealedInheritanceModel: Model<ISealedInheritance> =
  mongoose.models.SealedInheritance ||
  mongoose.model<ISealedInheritance>("SealedInheritance", SealedInheritanceSchema);

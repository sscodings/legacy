import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { getInheritance } from "@/lib/inheritance/store";
import { readVaultIsInSuccession } from "@/lib/inheritance/chain";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const vault = searchParams.get("vault");
    const heir = searchParams.get("heir");

    if (!vault || !isAddress(vault)) {
      return NextResponse.json({ error: "Invalid vault address" }, { status: 400 });
    }
    if (!heir || !isAddress(heir)) {
      return NextResponse.json({ error: "Invalid heir address" }, { status: 400 });
    }

    const record = await getInheritance(vault, heir);

    if (!record) {
      return NextResponse.json({
        enrolled: false,
        heirPublicKey: null,
        keyScheme: null,
        credentialId: null,
        hasSealed: false,
        hasSealedVideo: false,
        needsReseal: false,
        needsResealVideo: false,
        canReveal: false,
        bundle: null,
        video: null,
      });
    }

    const hasSealed = Boolean(record.sealedBundle);
    const hasSealedVideo = Boolean(record.sealedVideo);

    // If the heir re-enrolled with a new public key (e.g. upgraded to passkey or rotated),
    // existing sealed ciphertexts can no longer be decrypted with their current key.
    const needsReseal = Boolean(
      hasSealed &&
      record.heirPublicKey &&
      record.sealedForPublicKey &&
      record.sealedForPublicKey.toLowerCase() !== record.heirPublicKey.toLowerCase()
    );
    const needsResealVideo = Boolean(
      hasSealedVideo &&
      record.heirPublicKey &&
      record.sealedVideoForPublicKey &&
      record.sealedVideoForPublicKey.toLowerCase() !== record.heirPublicKey.toLowerCase()
    );

    // The sealed ciphertext (and the encrypted video's blob URL) is only
    // released once the vault has entered succession (Red). Both are
    // encrypted regardless, but this enforces the "only after succession"
    // reveal rule server-side, not just in the UI.
    let canReveal = false;
    if (hasSealed || hasSealedVideo) {
      try {
        canReveal = await readVaultIsInSuccession(vault as `0x${string}`);
      } catch (err) {
        console.warn("[Inheritance] succession status check failed:", err);
        canReveal = false;
      }
    }

    return NextResponse.json({
      enrolled: Boolean(record.heirPublicKey),
      heirPublicKey: record.heirPublicKey || null,
      keyScheme: record.keyScheme || "wallet-signature",
      credentialId: record.credentialId ?? null,
      hasSealed,
      hasSealedVideo,
      needsReseal,
      needsResealVideo,
      sealedAt: record.sealedAt ?? null,
      sealedVideoAt: record.sealedVideoAt ?? null,
      canReveal,
      bundle: canReveal ? record.sealedBundle : null,
      video: canReveal ? record.sealedVideo ?? null : null,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to load inheritance record";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

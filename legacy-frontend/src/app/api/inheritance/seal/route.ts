import { NextResponse } from "next/server";
import { isAddress, recoverMessageAddress } from "viem";
import { buildSealMessage, digestBundle, type SealedBundle } from "@/lib/inheritance/crypto";
import { getInheritance, saveSealedBundle } from "@/lib/inheritance/store";
import { readVaultOwner } from "@/lib/inheritance/chain";

export const dynamic = "force-dynamic";

interface SealRequest {
  vaultAddress: `0x${string}`;
  heirAddress: `0x${string}`;
  ownerAddress: `0x${string}`;
  bundle: SealedBundle;
  signature: `0x${string}`;
}

export async function POST(request: Request) {
  try {
    const body: SealRequest = await request.json();

    if (!body.vaultAddress || !isAddress(body.vaultAddress)) {
      return NextResponse.json({ error: "Invalid vaultAddress" }, { status: 400 });
    }
    if (!body.heirAddress || !isAddress(body.heirAddress)) {
      return NextResponse.json({ error: "Invalid heirAddress" }, { status: 400 });
    }
    if (!body.ownerAddress || !isAddress(body.ownerAddress)) {
      return NextResponse.json({ error: "Invalid ownerAddress" }, { status: 400 });
    }
    const b = body.bundle;
    if (!b || !b.ephPub || !b.nonce || !b.ct) {
      return NextResponse.json({ error: "Malformed sealed bundle" }, { status: 400 });
    }
    if (!body.signature || !body.signature.startsWith("0x")) {
      return NextResponse.json({ error: "Missing owner signature" }, { status: 400 });
    }

    // The owner signs over the bundle digest — this authenticates the writer and
    // binds the signature to this exact ciphertext (no swapping after signing).
    const digest = digestBundle(b);
    const message = buildSealMessage(body.vaultAddress, body.heirAddress, digest);
    let recovered: `0x${string}`;
    try {
      recovered = await recoverMessageAddress({ message, signature: body.signature });
    } catch {
      return NextResponse.json({ error: "Signature verification failed" }, { status: 400 });
    }
    if (recovered.toLowerCase() !== body.ownerAddress.toLowerCase()) {
      return NextResponse.json({ error: "Signature does not match ownerAddress." }, { status: 401 });
    }

    // Only the vault's on-chain owner may seal a message.
    try {
      const onChainOwner = await readVaultOwner(body.vaultAddress);
      if (onChainOwner.toLowerCase() !== body.ownerAddress.toLowerCase()) {
        return NextResponse.json(
          { error: "Only the vault owner can seal an inheritance message." },
          { status: 403 }
        );
      }
    } catch (err) {
      console.warn("[Inheritance/seal] owner check failed:", err);
      return NextResponse.json({ error: "Unable to verify vault owner on-chain." }, { status: 502 });
    }

    // The heir must have enrolled (published a public key) before sealing.
    const existing = await getInheritance(body.vaultAddress, body.heirAddress);
    if (!existing || !existing.heirPublicKey) {
      return NextResponse.json(
        { error: "This heir has not enrolled yet. Ask them to enroll their decryption key first." },
        { status: 409 }
      );
    }

    const record = await saveSealedBundle(
      body.vaultAddress,
      body.heirAddress,
      b,
      body.ownerAddress,
      existing.heirPublicKey
    );
    if (!record) {
      return NextResponse.json({ error: "Failed to store sealed message." }, { status: 500 });
    }

    return NextResponse.json({ success: true, sealedAt: record.sealedAt });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Seal failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

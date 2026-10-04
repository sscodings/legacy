import { NextResponse } from "next/server";
import { isAddress, recoverMessageAddress } from "viem";
import { buildEnrollProofMessage, type KeyScheme } from "@/lib/inheritance/crypto";
import { saveEnrollment } from "@/lib/inheritance/store";
import { readIsHeir } from "@/lib/inheritance/chain";

export const dynamic = "force-dynamic";

interface EnrollRequest {
  vaultAddress: `0x${string}`;
  heirAddress: `0x${string}`;
  keyScheme?: KeyScheme;
  heirPublicKey?: string;
  credentialId?: string;
  proofSignature?: `0x${string}`;
  issuedAt?: number;
  signature?: `0x${string}`;
}

export async function POST(request: Request) {
  try {
    const body: EnrollRequest = await request.json();

    // Reject deprecated legacy shape where the raw derivation signature was transmitted
    if (!body.keyScheme || !body.heirPublicKey || !body.proofSignature || typeof body.issuedAt !== "number") {
      return NextResponse.json(
        { error: "Legacy enrollment format deprecated. Please enroll with keyScheme, heirPublicKey, and proofSignature." },
        { status: 400 }
      );
    }

    if (!body.vaultAddress || !isAddress(body.vaultAddress)) {
      return NextResponse.json({ error: "Invalid vaultAddress" }, { status: 400 });
    }
    if (!body.heirAddress || !isAddress(body.heirAddress)) {
      return NextResponse.json({ error: "Invalid heirAddress" }, { status: 400 });
    }
    if (body.keyScheme !== "wallet-signature" && body.keyScheme !== "passkey-prf") {
      return NextResponse.json({ error: "Invalid keyScheme. Must be 'wallet-signature' or 'passkey-prf'." }, { status: 400 });
    }
    if (!/^[0-9a-fA-F]{64}$/.test(body.heirPublicKey)) {
      return NextResponse.json({ error: "Invalid heirPublicKey. Must be a 32-byte hex public key (64 hex chars)." }, { status: 400 });
    }
    if (body.keyScheme === "passkey-prf" && (!body.credentialId || typeof body.credentialId !== "string")) {
      return NextResponse.json({ error: "Missing credentialId for passkey-prf scheme." }, { status: 400 });
    }
    if (!body.proofSignature.startsWith("0x")) {
      return NextResponse.json({ error: "Missing or malformed proofSignature." }, { status: 400 });
    }

    // Verify freshness of proof signature (10-minute window)
    const now = Date.now();
    if (Math.abs(now - body.issuedAt) > 10 * 60 * 1000) {
      return NextResponse.json({ error: "Proof signature expired or invalid timestamp." }, { status: 400 });
    }

    // The signature must be over the canonical proof message for this exact key enrollment.
    // This cryptographically proves that the heir wallet authorized publishing this public key.
    const message = buildEnrollProofMessage({
      vault: body.vaultAddress,
      heir: body.heirAddress,
      heirPublicKey: body.heirPublicKey.toLowerCase(),
      scheme: body.keyScheme,
      issuedAt: body.issuedAt,
    });

    let recovered: `0x${string}`;
    try {
      recovered = await recoverMessageAddress({ message, signature: body.proofSignature });
    } catch {
      return NextResponse.json({ error: "Proof signature verification failed." }, { status: 400 });
    }

    if (recovered.toLowerCase() !== body.heirAddress.toLowerCase()) {
      return NextResponse.json(
        { error: "Proof signature does not match the provided heir address." },
        { status: 401 }
      );
    }

    // Only genuine on-chain heirs may enroll for a vault.
    try {
      const isHeir = await readIsHeir(body.vaultAddress, body.heirAddress);
      if (!isHeir) {
        return NextResponse.json(
          { error: "This address is not a registered heir of the vault." },
          { status: 403 }
        );
      }
    } catch (err) {
      console.warn("[Inheritance/enroll] isHeir check failed:", err);
      return NextResponse.json({ error: "Unable to verify heir status on-chain." }, { status: 502 });
    }

    // Store the public key and keyScheme. Note: The server never derives or receives any private key.
    const record = await saveEnrollment(
      body.vaultAddress,
      body.heirAddress,
      body.heirPublicKey.toLowerCase(),
      body.keyScheme,
      body.credentialId
    );

    return NextResponse.json({
      success: true,
      heirPublicKey: record.heirPublicKey,
      keyScheme: record.keyScheme,
      credentialId: record.credentialId ?? null,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Enrollment failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

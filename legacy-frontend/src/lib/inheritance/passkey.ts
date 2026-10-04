// WebAuthn PRF (Pseudo-Random Function) extension helper for passkey-sealed inheritance.
// Derives high-entropy, deterministic symmetric secrets tied to the user's biometric
// or security key without revealing any private key to the browser or server.

import { buildPrfSalt } from "./crypto";

export class PrfUnsupportedError extends Error {
  constructor(message = "WebAuthn PRF extension is not supported by this authenticator/browser.") {
    super(message);
    this.name = "PrfUnsupportedError";
  }
}

/**
 * Base64URL encode a buffer.
 */
export function bufferToBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Base64URL decode into Uint8Array.
 */
export function base64UrlToBuffer(base64url: string): Uint8Array {
  let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Zero out sensitive in-memory Uint8Array buffers.
 */
export function zeroBuffer(buf: Uint8Array): void {
  buf.fill(0);
}

/**
 * Check if the browser and platform authenticator support WebAuthn and passkeys.
 * Never throws.
 */
export async function isPasskeyPrfAvailable(): Promise<boolean> {
  if (typeof window === "undefined" || !window.isSecureContext) {
    return false;
  }
  if (!window.PublicKeyCredential) {
    return false;
  }
  try {
    if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function") {
      const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      return available;
    }
  } catch {
    return false;
  }
  return true;
}

interface WebAuthnPrfExtensionResults {
  enabled?: boolean;
  results?: {
    first?: ArrayBuffer;
    second?: ArrayBuffer;
  };
}

/**
 * Create a new resident passkey with PRF evaluation enabled.
 */
export async function createHeirPasskey(
  vault: string,
  heir: string
): Promise<{ credentialId: string; prfOutput: Uint8Array }> {
  if (typeof window === "undefined" || !navigator.credentials) {
    throw new PrfUnsupportedError("WebAuthn is not supported in this environment.");
  }

  const salt = buildPrfSalt(vault, heir);
  const challenge = window.crypto.getRandomValues(new Uint8Array(32));
  const userId = new TextEncoder().encode(`${vault.toLowerCase()}:${heir.toLowerCase()}`);
  const heirShort = `${heir.slice(0, 6)}...${heir.slice(-4)}`;

  const createOptions: CredentialCreationOptions = {
    publicKey: {
      challenge: challenge.buffer as ArrayBuffer,
      rp: {
        name: "Legacy Protocol",
      },
      user: {
        id: userId.buffer as ArrayBuffer,
        name: `legacy-heir-${heirShort}`,
        displayName: `Legacy Heir (${heirShort})`,
      },
      pubKeyCredParams: [
        { alg: -7, type: "public-key" }, // ES256
        { alg: -257, type: "public-key" }, // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "required",
        requireResidentKey: true,
      },
      timeout: 60000,
      extensions: {
        prf: {
          eval: {
            first: salt.buffer as ArrayBuffer,
          },
        },
      } as unknown as AuthenticationExtensionsClientInputs,
    },
  };

  const credential = (await navigator.credentials.create(createOptions)) as PublicKeyCredential | null;
  if (!credential) {
    throw new Error("Passkey creation was cancelled or returned empty.");
  }

  const credentialId = bufferToBase64Url(credential.rawId);
  const extensionResults = credential.getClientExtensionResults() as Record<string, unknown>;
  const prf = extensionResults.prf as WebAuthnPrfExtensionResults | undefined;

  if (prf?.results?.first) {
    return {
      credentialId,
      prfOutput: new Uint8Array(prf.results.first.slice(0)),
    };
  }

  // Some browsers / authenticators support PRF but only return the eval result on `get`
  // instead of registration. Attempt immediate evaluation.
  try {
    const prfOutput = await evaluateHeirPasskey(vault, heir, credentialId);
    return { credentialId, prfOutput };
  } catch (err) {
    throw new PrfUnsupportedError(
      "Your authenticator created the passkey but did not support PRF key derivation: " +
        (err instanceof Error ? err.message : String(err))
    );
  }
}

/**
 * Prompt the user for biometric / passkey verification to evaluate the PRF secret.
 */
export async function evaluateHeirPasskey(
  vault: string,
  heir: string,
  credentialId?: string
): Promise<Uint8Array> {
  if (typeof window === "undefined" || !navigator.credentials) {
    throw new PrfUnsupportedError("WebAuthn is not supported in this environment.");
  }

  const salt = buildPrfSalt(vault, heir);
  const challenge = window.crypto.getRandomValues(new Uint8Array(32));

  const getOptions: CredentialRequestOptions = {
    publicKey: {
      challenge: challenge.buffer as ArrayBuffer,
      userVerification: "required",
      timeout: 60000,
      allowCredentials: credentialId
        ? [
            {
              id: base64UrlToBuffer(credentialId).buffer as ArrayBuffer,
              type: "public-key",
            },
          ]
        : undefined,
      extensions: {
        prf: {
          eval: {
            first: salt.buffer as ArrayBuffer,
          },
        },
      } as unknown as AuthenticationExtensionsClientInputs,
    },
  };

  const assertion = (await navigator.credentials.get(getOptions)) as PublicKeyCredential | null;
  if (!assertion) {
    throw new Error("Passkey verification was cancelled or returned empty.");
  }

  const extensionResults = assertion.getClientExtensionResults() as Record<string, unknown>;
  const prf = extensionResults.prf as WebAuthnPrfExtensionResults | undefined;

  if (!prf?.results?.first) {
    throw new PrfUnsupportedError("Authenticator did not return PRF evaluation output.");
  }

  return new Uint8Array(prf.results.first.slice(0));
}

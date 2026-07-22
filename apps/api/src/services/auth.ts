import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyMessage } from "viem";
import { normalizeAddress } from "@rugkiller/chain";
import { config } from "../config.js";

type TokenPayload = { address: string; exp: number; nonce?: string; kind: "challenge" | "session" };

function sign(encoded: string) {
  return createHmac("sha256", config.jwtSecret).update(encoded).digest("base64url");
}

function encode(payload: TokenPayload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

function decode(token: string, kind: TokenPayload["kind"]) {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const expected = sign(encoded);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as TokenPayload;
  if (payload.kind !== kind || payload.exp < Date.now()) return null;
  return payload;
}

export function createWalletChallenge(addressInput: string) {
  const address = normalizeAddress(addressInput);
  if (!address) throw new Error("Invalid wallet address.");
  const payload: TokenPayload = {
    address: address.toLowerCase(),
    exp: Date.now() + 5 * 60_000,
    nonce: randomBytes(16).toString("hex"),
    kind: "challenge",
  };
  const challenge = encode(payload);
  return {
    challenge,
    message: `RiskHound authentication\nAddress: ${payload.address}\nNonce: ${payload.nonce}\nExpires: ${new Date(payload.exp).toISOString()}`,
    expiresAt: new Date(payload.exp).toISOString(),
  };
}

export async function verifyWalletChallenge(input: { challenge: string; message: string; signature: `0x${string}` }) {
  const payload = decode(input.challenge, "challenge");
  if (!payload) return null;
  const expected = `RiskHound authentication\nAddress: ${payload.address}\nNonce: ${payload.nonce}\nExpires: ${new Date(payload.exp).toISOString()}`;
  if (input.message !== expected) return null;
  const valid = await verifyMessage({ address: payload.address as `0x${string}`, message: expected, signature: input.signature });
  if (!valid) return null;
  return {
    address: payload.address,
    sessionToken: encode({ address: payload.address, exp: Date.now() + 7 * 24 * 60 * 60_000, kind: "session" }),
  };
}

export function authenticatedAddress(headers: Record<string, unknown>) {
  const auth = headers.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return null;
  return decode(auth.slice(7), "session")?.address ?? null;
}

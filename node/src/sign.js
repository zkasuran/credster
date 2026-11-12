// Request signatures (buyer -> seller node), receipts (seller node -> buyer),
// and the NEAR AI Cloud TEE signature check used by the grader.
import { createHash } from "node:crypto";
import { PublicKey } from "near-api-js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

export const sha256hex = (b) => createHash("sha256").update(b).digest("hex");

const enc = new TextEncoder();

/** The bytes a buyer signs for one gateway request. */
export function requestMessage(orderId, ts, bodyBytes) {
  return enc.encode(`credster/req/v1|${orderId}|${ts}|${sha256hex(bodyBytes)}`);
}

export function signRequest(keyPair, orderId, bodyBytes, ts = Date.now()) {
  const sig = keyPair.sign(requestMessage(orderId, ts, bodyBytes)).signature;
  return { "x-ts-order": String(orderId), "x-ts-ts": String(ts), "x-ts-sig": Buffer.from(sig).toString("base64") };
}

export function verifyEd25519(publicKeyStr, msgBytes, sigBytes) {
  try {
    return PublicKey.fromString(publicKeyStr).verify(msgBytes, sigBytes);
  } catch {
    return false;
  }
}

/** Canonical receipt text: fixed key order, so both sides hash the same bytes. */
export function receiptText(r) {
  return JSON.stringify({
    v: 1,
    listing: String(r.listing),
    order: String(r.order),
    seq: r.seq,
    req: r.req,
    resp: r.resp,
    in: r.in,
    out: r.out,
    ts: r.ts,
    chat_id: r.chat_id || "",
  });
}

export function signReceipt(nodeKeyPair, r) {
  const text = receiptText(r);
  const sig = nodeKeyPair.sign(enc.encode(text)).signature;
  return { text, sig: Buffer.from(sig).toString("base64") };
}

export function verifyReceipt(nodeKeyStr, text, sigB64) {
  return verifyEd25519(nodeKeyStr, enc.encode(text), Buffer.from(sigB64, "base64"));
}

/** sha256 over receipt texts joined by "\n", in seq order. */
export function receiptsHash(texts) {
  return sha256hex(texts.join("\n"));
}

/** EIP-191 personal_sign recovery. Returns the lowercase 0x address. */
export function recoverEip191(text, sigHex) {
  const msg = enc.encode(text);
  const prefix = enc.encode(`\x19Ethereum Signed Message:\n${msg.length}`);
  const digest = keccak_256(new Uint8Array([...prefix, ...msg]));
  const raw = Buffer.from(sigHex.replace(/^0x/, ""), "hex");
  if (raw.length !== 65) throw new Error("signature must be 65 bytes");
  let v = raw[64];
  if (v >= 27) v -= 27;
  const sig = new Uint8Array([v, ...raw.subarray(0, 64)]);
  const pub = secp256k1.Signature.fromBytes(sig, "recovered").recoverPublicKey(digest).toBytes(false);
  const addr = keccak_256(pub.subarray(1)).subarray(12);
  return "0x" + Buffer.from(addr).toString("hex");
}

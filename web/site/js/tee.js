// Checks one answer's NEAR AI TEE signature in the browser.
// NEAR AI Cloud signs "<model>:sha256(request):sha256(response)" (EIP-191) with a key
// held in an attested enclave; its public attestation report lists those signers.
import { secp256k1, keccak_256 } from "../vendor/noble-secp256k1-keccak.js";
import { utf8, toHex } from "./near-lite.js";

const PROVIDER = "https://cloud-api.near.ai";
const cache = new Map();

export async function attestedAddresses(model) {
  const hit = cache.get(model);
  if (hit && Date.now() - hit.at < 600_000) return hit.addresses;
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  try {
    const r = await fetch(`${PROVIDER}/v1/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`);
    if (!r.ok) return null;
    const j = await r.json();
    const addresses = (j.model_attestations || j.all_attestations || []).map((a) => String(a.signing_address || "").toLowerCase()).filter(Boolean);
    cache.set(model, { at: Date.now(), addresses });
    return addresses;
  } catch { return null; }
}

export function recoverEip191(text, sigHex) {
  const msg = utf8(text);
  const digest = keccak_256(new Uint8Array([...utf8(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]));
  const hex = String(sigHex).replace(/^0x/, "");
  const raw = Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
  let v = raw[64];
  if (v >= 27) v -= 27;
  const pub = secp256k1.Signature.fromBytes(new Uint8Array([v, ...raw.subarray(0, 64)]), "recovered").recoverPublicKey(digest).toBytes(false);
  return "0x" + toHex(keccak_256(pub.subarray(1)).subarray(12));
}

/** verdict: verified | contradicts | altered | unsigned | none (model has no TEE signers) */
export async function checkAnswer(endpoint, { chatId, model, reqHash, respHash }) {
  const listed = await attestedAddresses(model);
  if (listed && !listed.length) return { verdict: "none", reason: `NEAR AI publishes no TEE signers for ${model}` };
  if (!chatId) return { verdict: "unsigned", reason: "the answer carries no chat id" };
  let sig = null;
  for (let i = 0; i < 4 && !sig; i++) {
    try {
      const r = await fetch(`${endpoint.replace(/\/$/, "")}/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}`);
      if (r.ok) { const j = await r.json(); if (j?.text && j?.signature) sig = j; }
    } catch {}
    if (!sig) await new Promise((s) => setTimeout(s, 1500));
  }
  if (!sig) return { verdict: "unsigned", reason: "the seller node relayed no TEE signature" };
  let signer;
  try { signer = recoverEip191(sig.text, sig.signature); } catch { return { verdict: "unsigned", reason: "the signature does not recover" }; }
  const parts = String(sig.text).split(":");
  const signedModel = parts.length >= 3 ? parts.slice(0, -2).join(":") : "";
  const [sReq, sResp] = parts.slice(-2);
  if (signedModel && signedModel !== model) {
    const other = await attestedAddresses(signedModel);
    if (other?.includes(signer)) return { verdict: "contradicts", signedModel, signer, reason: `the TEE signature shows ${signedModel} answered, not ${model}` };
    return { verdict: "unsigned", signer, reason: `the signature names ${signedModel}, from a signer not attested for it` };
  }
  if (!listed?.includes(signer)) return { verdict: "unsigned", signer, reason: `the signer is not in NEAR AI's attestation report for ${model}` };
  if (sReq !== reqHash) return { verdict: "altered", signer, reason: "the signed request differs from the request you sent" };
  if (sResp !== respHash) return { verdict: "altered", signer, reason: "the signed answer differs from the one you received (its text or usage was changed)" };
  return { verdict: "verified", signer, signedModel: model };
}

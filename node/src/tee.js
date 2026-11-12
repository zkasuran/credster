// TEE signature checks for one answer, shared by the grader, disputes and buyers.
//
// NEAR AI Cloud signs "<model>:sha256(request bytes):sha256(response bytes)" with a
// key held in an attested enclave (EIP-191, secp256k1). Its public attestation
// report lists the signing addresses for each model it serves in a TEE.
import { randomInt } from "node:crypto";
import { recoverEip191 } from "./sign.js";
import { verifyHardware } from "./attest.js";

const PROVIDER = process.env.TS_PROVIDER || "https://cloud-api.near.ai";
const cache = new Map(); // model -> { at, addresses }

/** Signing addresses NEAR AI's public attestation report lists for a model (cached 10 min). */
export async function attestedAddresses(model) {
  const hit = cache.get(model);
  if (hit && Date.now() - hit.at < 600_000) return hit.addresses;
  const nonce = Buffer.from(Array.from({ length: 32 }, () => randomInt(256))).toString("hex");
  try {
    const r = await fetch(`${PROVIDER}/v1/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) return null;
    const j = await r.json();
    const addresses = (j.model_attestations || j.all_attestations || []).map((a) => String(a.signing_address || "").toLowerCase()).filter(Boolean);
    cache.set(model, { at: Date.now(), addresses });
    return addresses;
  } catch {
    return null;
  }
}

/** Tests only: pins the attested signers for a model so no network call is made. */
export function _pinAttested(model, addresses) {
  cache.set(model, { at: Date.now() + 1e12, addresses: addresses.map((a) => a.toLowerCase()) });
}

/** True when the provider serves this model in a TEE with published signers. */
export async function teeCapable(model) {
  const a = await attestedAddresses(model);
  return !!a && a.length > 0;
}

/**
 * Judges one signature against the bytes the buyer saw.
 * verdict:
 *   verified     signed text is "<model>:<reqHash>:<respHash>" and the signer is attested for <model>
 *   contradicts  a valid, attested signature names a different model
 *   altered      the claimed model signed, but over different response bytes (the answer or its usage was changed)
 *   unsigned     no usable signature was relayed
 */
export async function judgeSignature(sig, { model, reqHash, respHash }) {
  if (!sig?.text || !sig?.signature) return { verdict: "unsigned", reason: "the seller node relayed no TEE signature" };
  let signer;
  try { signer = recoverEip191(sig.text, sig.signature); } catch { return { verdict: "unsigned", reason: "the relayed signature does not recover" }; }
  if (sig.signing_address && signer !== String(sig.signing_address).toLowerCase()) return { verdict: "unsigned", reason: "the relayed signature does not match its stated signer" };
  const parts = String(sig.text).split(":");
  const signedModel = parts.length >= 3 ? parts.slice(0, -2).join(":") : "";
  const [sReq, sResp] = parts.slice(-2);
  if (signedModel && signedModel !== model) {
    const other = await attestedAddresses(signedModel);
    if (other?.includes(signer)) return { verdict: "contradicts", signedModel, signer, reason: `the TEE signature shows ${signedModel} answered, not ${model}` };
    return { verdict: "unsigned", signedModel, signer, reason: `the signature names ${signedModel}, from a signer not attested for it` };
  }
  const listed = await attestedAddresses(model);
  if (!listed?.includes(signer)) return { verdict: "unsigned", signer, reason: `the signer is not in NEAR AI's attestation report for ${model}` };
  if (sReq !== reqHash) return { verdict: "altered", signer, reason: "the signed request differs from the request that was sent" };
  if (sResp !== respHash) return { verdict: "altered", signer, reason: "the signed response differs from the answer that was delivered (its text or usage was changed)" };
  return { verdict: "verified", signer, signedModel: model };
}

/** judgeSignature plus the hardware behind the signer (Intel TDX quote and NVIDIA GPUs). */
export async function judgeWithHardware(sig, ctx) {
  const v = await judgeSignature(sig, ctx);
  if (v.verdict !== "verified" && v.verdict !== "contradicts") return v;
  const hw = await verifyHardware(v.signedModel || ctx.model, v.signer);
  if (!hw.ok) return { verdict: "unsigned", signer: v.signer, reason: `the signer's hardware attestation failed: ${hw.steps.find((s) => !s.ok)?.check}`, hardware: hw };
  return { ...v, hardware: { ok: true, tdx: hw.tdx?.status, gpus: hw.nvidia?.gpus } };
}

/** Fetches the signature for one answer through the seller node, with retries. */
export async function fetchSignature(endpoint, chatId, model, { tries = 4, waitMs = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${endpoint.replace(/\/$/, "")}/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}`, { signal: AbortSignal.timeout(30_000) });
      if (r.ok) {
        const j = await r.json();
        if (j?.text && j?.signature) return j;
      }
    } catch {}
    await new Promise((s) => setTimeout(s, waitMs));
  }
  return null;
}

/** Fetch and judge in one step. */
export async function checkAnswer(endpoint, { chatId, model, reqHash, respHash }) {
  if (!chatId) return { verdict: "unsigned", reason: "the answer carries no chat id" };
  return judgeWithHardware(await fetchSignature(endpoint, chatId, model), { model, reqHash, respHash });
}

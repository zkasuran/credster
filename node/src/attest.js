// Hardware attestation for a NEAR AI signing key, checked by us rather than taken
// from NEAR AI's word:
//   1. The Intel TDX quote verifies against Intel's own PCS collateral (dcap-qvl).
//   2. The quote's report data binds the signing address and the fresh nonce we sent,
//      so the key lives in that TDX VM and the quote was made for this request.
//   3. NVIDIA's attestation service (NRAS) accepts the GPU evidence, and its ES384
//      verdict verifies against NVIDIA's published keys and carries the same nonce.
// It does not pin which software image runs: the measurements are recorded in the report.
import { createPublicKey, createVerify, randomBytes } from "node:crypto";
import { getCollateral, verify, INTEL_PCS_URL, PHALA_PCCS_URL } from "@phala/dcap-qvl";

const PROVIDER = process.env.TS_PROVIDER || "https://cloud-api.near.ai";
const PCS = process.env.TS_PCS_URL || INTEL_PCS_URL;
const NRAS = process.env.TS_NRAS_URL || "https://nras.attestation.nvidia.com";
const ACCEPT_TCB = new Set(["UpToDate", "SWHardeningNeeded", "ConfigurationAndSWHardeningNeeded"]);
const cache = new Map(); // signer -> { at, result }
let jwks = { at: 0, keys: [] };

const b64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

async function nvidiaKeys(kid) {
  if (!jwks.keys.some((k) => k.kid === kid) || Date.now() - jwks.at > 3600_000) {
    const r = await fetch(`${NRAS}/.well-known/jwks.json`, { signal: AbortSignal.timeout(30_000) });
    jwks = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  return jwks.keys.find((k) => k.kid === kid);
}

/** Verifies an NVIDIA ES384 JWT. Returns its claims, or throws. */
export async function verifyNvidiaJwt(token) {
  const [h, p, s] = token.split(".");
  const header = JSON.parse(b64url(h));
  if (header.alg !== "ES384") throw new Error(`unexpected JWT alg ${header.alg}`);
  const jwk = await nvidiaKeys(header.kid);
  if (!jwk) throw new Error(`NVIDIA key ${header.kid} not in the published key set`);
  const ok = createVerify("sha384").update(`${h}.${p}`).verify({ key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, b64url(s));
  if (!ok) throw new Error("NVIDIA verdict signature does not verify");
  const claims = JSON.parse(b64url(p));
  if (claims.iss !== NRAS) throw new Error(`unexpected issuer ${claims.iss}`);
  if (claims.exp && claims.exp * 1000 < Date.now()) throw new Error("NVIDIA verdict expired");
  return claims;
}

/** Checks the TDX quote and the GPU evidence behind one signing address. */
export async function verifyHardware(model, signer) {
  signer = String(signer).toLowerCase();
  const hit = cache.get(signer);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.result;
  const nonce = randomBytes(32).toString("hex");
  const out = { ok: false, model, signer, nonce, checked_at: new Date().toISOString(), steps: [] };
  const step = (check, ok, extra = {}) => { out.steps.push({ check, ok, ...extra }); return ok; };
  try {
    const r = await fetch(`${PROVIDER}/v1/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`, { signal: AbortSignal.timeout(60_000) });
    const rep = await r.json();
    const a = (rep.model_attestations || []).find((x) => String(x.signing_address).toLowerCase() === signer);
    if (!step("the attestation report lists this signer", !!a)) return out;

    // 1 and 2: the Intel TDX quote.
    const quote = Buffer.from(a.intel_quote, "hex");
    // Collateral is signed by Intel and checked against Intel's root CA, so a mirror
    // cannot forge it; Phala's PCCS is the fallback when Intel's PCS does not answer.
    let collateral = null, source = null;
    for (const url of [PCS, PCS, PHALA_PCCS_URL]) {
      try { collateral = await getCollateral(url, quote); source = url; break; } catch {}
    }
    if (!step("Intel collateral fetched", !!collateral)) return out;
    const v = verify(quote, collateral, Date.now() / 1000);
    out.tdx = { status: v.status, advisories: v.advisory_ids || [], mrtd: a.info?.tcb_info?.mrtd, compose_hash: a.info?.compose_hash, app_name: a.info?.app_name, collateral: source };
    if (!step(`Intel TDX quote verifies against Intel PCS (TCB ${v.status})`, ACCEPT_TCB.has(v.status))) return out;
    const rd = Buffer.from(v.report?.data?.reportData || []).toString("hex");
    step("the quote's report data binds the signing address", rd.slice(0, 40) === signer.slice(2));
    step("the quote's report data binds our fresh nonce", rd.slice(64) === nonce);

    // 3: the GPU evidence, judged by NVIDIA.
    const payload = JSON.parse(a.nvidia_payload || "null");
    if (step("NEAR AI sent GPU evidence for our nonce", !!payload && payload.nonce === nonce)) {
      const n = await fetch(`${NRAS}/v3/attest/gpu`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(60_000) });
      const body = await n.json();
      const overall = await verifyNvidiaJwt(body[0][1]);
      const gpus = await Promise.all(Object.values(body[1] || {}).map(verifyNvidiaJwt));
      out.nvidia = { arch: payload.arch, gpus: gpus.length, overall: overall["x-nvidia-overall-att-result"], driver: gpus[0]?.["x-nvidia-gpu-driver-version"], hwmodel: gpus[0]?.hwmodel };
      step(`NVIDIA attests ${gpus.length} GPU(s), signed verdict, overall result true`, overall["x-nvidia-overall-att-result"] === true && overall.eat_nonce === nonce);
      step("every GPU: measurements match, secure boot on, debug off", gpus.length > 0 && gpus.every((g) => g.measres === "success" && g.secboot === true && g.dbgstat === "disabled" && g.eat_nonce === nonce));
    }
    out.ok = out.steps.every((s) => s.ok);
  } catch (e) {
    step(`attestation check failed: ${e.message.slice(0, 160)}`, false);
  }
  cache.set(signer, { at: Date.now(), result: out });
  return out;
}

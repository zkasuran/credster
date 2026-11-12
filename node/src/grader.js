// Grading engine. It buys a small trial order like any buyer, probes the
// seller's endpoint, compares what it sees with reference fingerprints taken
// straight from the model provider, checks TEE signatures where the model has
// them, and posts the grade on chain with the sha256 of the full report.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomInt } from "node:crypto";
import { view, viewAll, call, near, fmtNear } from "./near.js";
import { sha256hex, recoverEip191, verifyReceipt, receiptsHash } from "./sign.js";
import { FINGERPRINT_PROBES, fingerprintRequest, capabilityTasks, capabilityRequest } from "./probes.js";
import { Buyer } from "./buyer.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FINGERPRINTS = join(HERE, "..", "fingerprints.json");
export const REPORTS = process.env.TS_REPORTS || join(HERE, "..", "..", "web", "reports");
// Where browsers fetch reports from. Unset: "reports/<file>", relative to the
// dashboard (the repo's web/reports). The live server sets an absolute URL.
const REPORT_BASE = (process.env.TS_REPORT_BASE_URL || "reports").replace(/\/$/, "");
const PROVIDER = process.env.TS_PROVIDER || "https://cloud-api.near.ai";

const loadRefs = () => (existsSync(FINGERPRINTS) ? JSON.parse(readFileSync(FINGERPRINTS, "utf8")) : { models: {} });

async function providerChat(key, body) {
  const t0 = Date.now();
  const r = await fetch(`${PROVIDER}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${body.model}: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return { usage: j.usage, ms: Date.now() - t0 };
}

/** Measures reference prompt token counts straight from the provider, twice. */
export async function buildFingerprints(models, key) {
  const refs = loadRefs();
  for (const model of models) {
    const runs = [];
    for (let run = 0; run < 2; run++) {
      const counts = [];
      for (let i = 0; i < FINGERPRINT_PROBES.length; i++) counts.push((await providerChat(key, fingerprintRequest(model, i))).usage.prompt_tokens);
      runs.push(counts);
    }
    const stable = JSON.stringify(runs[0]) === JSON.stringify(runs[1]);
    refs.models[model] = { counts: runs[0], stable, runs, measured_at: new Date().toISOString(), source: PROVIDER };
    console.log(`${model}: ${runs[0].join(", ")}${stable ? "" : "  UNSTABLE " + JSON.stringify(runs)}`);
  }
  refs.probes_sha256 = sha256hex(JSON.stringify(FINGERPRINT_PROBES));
  writeFileSync(FINGERPRINTS, JSON.stringify(refs, null, 2) + "\n");
  return refs;
}

/** Which reference model the observed counts match, if any. */
export function identify(observed, refs) {
  return Object.entries(refs.models).filter(([, r]) => r.stable && JSON.stringify(r.counts) === JSON.stringify(observed)).map(([m]) => m);
}

/**
 * Classifies observed counts against the claimed model's reference.
 * - match: every count equal.
 * - scaled: every count is the reference times one common factor k > 1.02
 *   (within one token of rounding), which is usage inflation.
 * - mismatch: anything else, which is a different tokenizer or template.
 */
export function compareFingerprint(observed, reference) {
  if (!reference) return { verdict: "no_reference" };
  if (observed.some((x) => typeof x !== "number")) return { verdict: "missing_usage" };
  if (observed.every((x, i) => x === reference[i])) return { verdict: "match", factor: 1 };
  const ks = observed.map((x, i) => x / reference[i]);
  const k = ks.reduce((a, b) => a + b, 0) / ks.length;
  const fits = observed.every((x, i) => Math.abs(x - Math.round(reference[i] * k)) <= 1);
  if (k > 1.02 && fits) return { verdict: "scaled", factor: Number(k.toFixed(3)) };
  return { verdict: "mismatch", factor: Number(k.toFixed(3)) };
}

async function attestationAddresses(model) {
  const nonce = Buffer.from(Array.from({ length: 32 }, () => randomInt(256))).toString("hex");
  const r = await fetch(`${PROVIDER}/v1/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) return { ok: false, status: r.status, addresses: [] };
  const j = await r.json();
  const list = j.model_attestations || j.all_attestations || [];
  return { ok: true, addresses: list.map((a) => String(a.signing_address || "").toLowerCase()).filter(Boolean) };
}

/**
 * TEE check. The seller node relays the provider's signature for one probe.
 * verdict:
 * - verified: the signed text is "<claimed model>:sha256(our request):sha256(our
 *   response)" and it recovers to an address the provider's public attestation
 *   report lists for the claimed model.
 * - contradicts: a valid provider signature names a different model, and that
 *   model's attestation report lists the signer. This is proof of substitution.
 * - unavailable: no usable signature. `tee_capable` says whether the claimed
 *   model has attested signers at the provider (then a seller should have one).
 */
export async function checkAttestation(endpoint, model, call1) {
  const claimedAtt = await attestationAddresses(model);
  const out = { verdict: "unavailable", attested: false, tee_capable: claimedAtt.ok && claimedAtt.addresses.length > 0, steps: [] };
  const chatId = call1?.json?.id;
  if (!chatId) return { ...out, reason: "no chat id" };
  let sig;
  for (let i = 0; i < 4 && !sig; i++) {
    const r = await fetch(`${endpoint.replace(/\/$/, "")}/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (r?.ok) sig = await r.json();
    else await new Promise((s) => setTimeout(s, 1500));
  }
  if (!sig?.text || !sig?.signature) return { ...out, reason: "seller node returned no signature" };
  let recovered = "";
  try { recovered = recoverEip191(sig.text, sig.signature); } catch (e) { return { ...out, reason: "signature does not recover: " + e.message }; }
  const sigOk = recovered === String(sig.signing_address).toLowerCase();
  out.steps.push({ check: "signature recovers to the stated signing address", fail: "signature does not recover to the stated signing address", ok: sigOk, recovered });
  const parts = sig.text.split(":");
  const signedModel = parts.length >= 3 ? parts.slice(0, -2).join(":") : null;
  const expected = `${model}:${sha256hex(call1.requestBytes)}:${sha256hex(call1.raw)}`;
  out.signed_model = signedModel;
  out.steps.push({ check: "signed text names the claimed model and our exact bytes", fail: signedModel === model ? "the signed response bytes differ from the bytes we received (the seller changed the answer)" : "the signature does not name the claimed model and our bytes", ok: sig.text === expected, got: sig.text.slice(0, 160) });
  out.steps.push({ check: "provider attestation report lists the signer for the claimed model", fail: "the claimed model's attestation report does not list this signer", ok: claimedAtt.addresses.includes(recovered), listed: claimedAtt.addresses });
  if (sigOk && sig.text === expected && claimedAtt.addresses.includes(recovered)) {
    return { ...out, verdict: "verified", attested: true };
  }
  if (sigOk && signedModel && signedModel !== model) {
    const other = await attestationAddresses(signedModel);
    const proven = other.addresses.includes(recovered);
    out.steps.push({ check: `attestation report for ${signedModel} lists the signer`, ok: proven, listed: other.addresses });
    if (proven) return { ...out, verdict: "contradicts", served_model: signedModel, reason: `a TEE signature shows ${signedModel} answered, not ${model}` };
  }
  return { ...out, reason: out.steps.find((s) => !s.ok)?.fail };
}

function p50(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

export function decideTier({ fingerprint, attestation, capabilityPct, errorPct }) {
  const fingerprintOk = fingerprint.verdict === "match";
  const meteringOk = fingerprint.verdict === "match";
  // Uniformly scaled counts mean the claimed tokenizer with inflated billing.
  const tokenizerOk = fingerprintOk || fingerprint.verdict === "scaled";
  const attested = attestation.verdict === "verified";
  const reasons = [];
  if (fingerprint.verdict === "scaled") reasons.push(`usage is ${fingerprint.factor}x the claimed model's token counts`);
  if (fingerprint.verdict === "mismatch") reasons.push(`token counts do not match the claimed model${fingerprint.looks_like?.length ? "; they match " + fingerprint.looks_like.join(", ") : ""}`);
  if (fingerprint.verdict === "no_reference") reasons.push("no reference fingerprint for the claimed model");
  if (fingerprint.verdict === "missing_usage") reasons.push("answers carry no usage numbers");
  if (attestation.verdict === "contradicts") reasons.push(attestation.reason);
  if (errorPct > 50) reasons.push(`${errorPct}% of probe calls failed`);
  let tier;
  if (!fingerprintOk || attestation.verdict === "contradicts" || errorPct > 50) tier = "F";
  else if (attested && capabilityPct >= 50 && errorPct <= 10) tier = "A";
  else if (!attested && attestation.tee_capable) {
    tier = "C";
    reasons.push("the claimed model has TEE signatures at the provider, but this seller gave none");
  } else if (capabilityPct >= 50 && errorPct <= 10) tier = "B";
  else tier = "C";
  if (tier === "C" && capabilityPct < 50) reasons.push(`only ${capabilityPct}% of checkable tasks correct`);
  // fingerprint_ok on chain means "the claimed model answered" as far as the
  // grader can tell, so a TEE contradiction clears it too.
  const modelOk = tokenizerOk && attestation.verdict !== "contradicts";
  const score = tier === "F" ? Math.min(20, capabilityPct / 5) : Math.round(40 + capabilityPct * 0.3 + (attested ? 20 : 0) + (10 - Math.min(10, errorPct)));
  return { tier, score: Math.max(0, Math.min(100, Math.round(score))), fingerprintOk: modelOk, meteringOk, attested, reasons };
}

/**
 * Grades one listing end to end. `opts.post` posts the grade on chain.
 * Returns { report, hash, file, tx }.
 */
export async function gradeListing(listingId, { grader, post = true, trialDeposit = near("0.05"), log = console.log } = {}) {
  const refs = loadRefs();
  const listing = await view("get_listing", { listing_id: String(listingId) });
  if (!listing) throw new Error(`no listing ${listingId}`);
  const buyer = new Buyer(grader);
  log(`grading listing ${listingId}: ${listing.model} at ${listing.endpoint} (seller ${listing.seller})`);

  // 1. A trial order, bought like any other buyer.
  const { value: orderId, txHash: orderTx } = await buyer.buySpot(listingId, trialDeposit);
  log(`  trial order ${orderId} (${fmtNear(trialDeposit)} NEAR) tx ${orderTx}`);

  const calls = [];
  const run = async (kind, body) => {
    try {
      const r = await buyer.chat(orderId, body, { endpoint: listing.endpoint, nodeKey: listing.node_key });
      calls.push({ kind, ok: r.ok, status: r.status, ms: r.ms, usage: r.json?.usage, receiptOk: r.receiptOk });
      return r;
    } catch (e) {
      calls.push({ kind, ok: false, error: e.message });
      return { ok: false, error: e.message };
    }
  };

  // 2. Fingerprint probes.
  const fp = [];
  for (let i = 0; i < FINGERPRINT_PROBES.length; i++) fp.push(await run("fingerprint", fingerprintRequest(listing.model, i)));
  const observed = fp.map((r) => r.json?.usage?.prompt_tokens ?? null);
  const reference = refs.models[listing.model]?.stable ? refs.models[listing.model].counts : null;
  const fingerprint = { observed, reference, ...compareFingerprint(observed, reference), looks_like: identify(observed, refs) };
  log(`  fingerprint observed ${JSON.stringify(observed)} reference ${JSON.stringify(reference)} -> ${fingerprint.verdict}${fingerprint.looks_like.length ? " (matches " + fingerprint.looks_like.join(", ") + ")" : ""}`);

  // 3. Fresh checkable tasks.
  const seed = randomInt(1, 2 ** 31);
  const tasks = capabilityTasks(seed);
  const capability = [];
  for (const t of tasks) {
    const r = await run("capability", capabilityRequest(listing.model, t));
    const text = r.json?.choices?.[0]?.message?.content ?? "";
    capability.push({ id: t.id, prompt: t.prompt, answer: String(text).trim().slice(-80), correct: r.ok && t.check(text) });
  }
  const capabilityPct = Math.round((100 * capability.filter((c) => c.correct).length) / capability.length);
  log(`  capability ${capability.map((c) => `${c.id}:${c.correct ? "ok" : "x"}`).join(" ")} = ${capabilityPct}%`);

  // 4. TEE signature on the first fingerprint call.
  const attestation = fp[0]?.ok ? await checkAttestation(listing.endpoint, listing.model, fp[0]) : { verdict: "unavailable", attested: false, tee_capable: false, reason: "first probe failed", steps: [] };
  log(`  attestation ${attestation.verdict}${attestation.reason ? ": " + attestation.reason : ""}`);

  const okCalls = calls.filter((c) => c.ok);
  const errorPct = Math.round((100 * (calls.length - okCalls.length)) / calls.length);
  const latency = p50(okCalls.map((c) => c.ms));
  const receiptsOk = okCalls.every((c) => c.receiptOk);
  const decision = decideTier({ fingerprint, attestation, capabilityPct, errorPct });
  if (!receiptsOk) {
    decision.reasons.push("some answers had no valid node-signed receipt");
    if (decision.tier !== "F") decision.tier = "C";
  }

  const report = {
    credster_report: 1,
    graded_at: new Date().toISOString(),
    grader,
    contract: process.env.TS_CONTRACT,
    listing: { id: String(listingId), seller: listing.seller, model: listing.model, endpoint: listing.endpoint, node_key: listing.node_key, ask_in: listing.ask_in, ask_out: listing.ask_out },
    trial_order: { id: String(orderId), tx: orderTx },
    fingerprint,
    probes_sha256: sha256hex(JSON.stringify(FINGERPRINT_PROBES)),
    capability: { seed, pct: capabilityPct, tasks: capability },
    attestation,
    calls: { total: calls.length, ok: okCalls.length, error_pct: errorPct, p50_latency_ms: latency, receipts_ok: receiptsOk, detail: calls },
    decision,
  };
  const text = JSON.stringify(report, null, 2) + "\n";
  const hash = sha256hex(text);
  mkdirSync(REPORTS, { recursive: true });
  const fileName = `listing-${listingId}-${Date.now()}.json`;
  writeFileSync(join(REPORTS, fileName), text);
  log(`  tier ${decision.tier} score ${decision.score}${decision.reasons.length ? " (" + decision.reasons.join("; ") + ")" : ""}; report sha256 ${hash}`);

  let tx = null;
  if (post) {
    const r = await call(grader, "post_grade", {
      listing_id: String(listingId),
      tier: decision.tier,
      score: decision.score,
      fingerprint_ok: decision.fingerprintOk,
      metering_ok: decision.meteringOk,
      attested: decision.attested,
      capability_pct: capabilityPct,
      p50_latency_ms: latency,
      error_pct: errorPct,
      report_hash: hash,
      report_url: `${REPORT_BASE}/${fileName}`,
    });
    tx = r.txHash;
    log(`  posted grade tx ${tx}`);
  }
  // The trial order is closed at once; the seller can still claim what it served.
  await buyer.close(orderId).catch((e) => log(`  close trial order: ${e.message.slice(0, 120)}`));
  return { report, hash, file: fileName, tx, orderId };
}

/**
 * Resolves disputed claims. The seller must show node-signed receipts whose
 * hash is the claim's receipts_hash and whose token sums equal the claim.
 * No proof, or a proof that does not add up, rejects the claim and slashes.
 */
export async function resolveDisputes({ grader, slashFactor = 2n, minSlash = 10n ** 22n, log = console.log, claims: known } = {}) {
  const claims = (known || (await viewAll("get_claims"))).filter((c) => c.status === "Disputed");
  const out = [];
  for (const c of claims) {
    const order = await view("get_order", { order_id: c.order_id });
    const listing = await view("get_listing", { listing_id: order.listing_id });
    const base = listing.endpoint.replace(/\/v1\/?$/, "");
    let proof = null;
    try {
      const r = await fetch(`${base}/credster/claims/${c.id}`, { signal: AbortSignal.timeout(30_000) });
      if (r.ok) proof = await r.json();
    } catch {}
    const checks = [];
    let uphold = false;
    if (!proof) checks.push("seller node gave no receipts for this claim");
    else {
      const sigsOk = proof.receipts.every((r) => verifyReceipt(listing.node_key, r.text, r.sig));
      const rs = proof.receipts.map((r) => JSON.parse(r.text));
      const forOrder = rs.every((r) => String(r.order) === String(c.order_id) && String(r.listing) === String(listing.id));
      const hashOk = receiptsHash(proof.receipts.map((r) => r.text)) === c.receipts_hash;
      const sumIn = rs.reduce((s, r) => s + r.in, 0), sumOut = rs.reduce((s, r) => s + r.out, 0);
      const sumsOk = sumIn === Number(c.in_tokens) && sumOut === Number(c.out_tokens) && rs.length === c.receipts;
      checks.push(`signatures ${sigsOk ? "valid" : "INVALID"}`, `receipts ${forOrder ? "belong to this order" : "NOT for this order"}`, `hash ${hashOk ? "matches" : "DOES NOT match"}`, `receipts sum ${sumIn} in / ${sumOut} out vs claim ${c.in_tokens} / ${c.out_tokens}`);
      uphold = sigsOk && forOrder && hashOk && sumsOk;
    }
    // Twice the claim, at least 0.01 NEAR; the contract caps it at the bond.
    const want = BigInt(c.amount) * slashFactor;
    const slash = uphold ? 0n : want > minSlash ? want : minSlash;
    const resolution = (uphold ? "upheld: " : "rejected: ") + checks.join("; ");
    const { txHash } = await call(grader, "resolve_dispute", { claim_id: c.id, uphold, slash: String(slash), resolution: resolution.slice(0, 280) });
    log(`claim ${c.id}: ${resolution} -> tx ${txHash}`);
    out.push({ claim: c.id, uphold, slash: String(slash), resolution, tx: txHash });
  }
  return out;
}


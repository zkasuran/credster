import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareFingerprint, identify, decideTier } from "../src/grader.js";
import { capabilityTasks } from "../src/probes.js";
import { cost, orderPrices } from "../src/pricing.js";
import { signReceipt, verifyReceipt, receiptsHash, signRequest, requestMessage, verifyEd25519, recoverEip191 } from "../src/sign.js";
import { nextAsk } from "../src/agents.js";
import { KeyPair } from "near-api-js";

const refs = JSON.parse(readFileSync(new URL("../fingerprints.json", import.meta.url)));
const qwen = refs.models["Qwen/Qwen3.8-27B"].counts;

test("fingerprint: exact match passes", () => {
  assert.equal(compareFingerprint([...qwen], qwen).verdict, "match");
});

test("fingerprint: a different tokenizer is a mismatch and is identified", () => {
  const other = refs.models["Qwen/Qwen3.6-35B-A3B-FP8"].counts;
  assert.equal(compareFingerprint(other, qwen).verdict, "mismatch");
  assert.deepEqual(identify(other, refs), ["Qwen/Qwen3.6-35B-A3B-FP8"]);
});

test("fingerprint: uniformly inflated usage is 'scaled' with its factor", () => {
  const r = compareFingerprint(qwen.map((x) => Math.round(x * 1.35)), qwen);
  assert.equal(r.verdict, "scaled");
  assert.ok(Math.abs(r.factor - 1.35) < 0.01);
});

test("fingerprint: one token off on one probe is a mismatch, not a pass", () => {
  assert.equal(compareFingerprint([qwen[0] + 1, qwen[1], qwen[2]], qwen).verdict, "mismatch");
});

test("fingerprint: missing usage and missing reference never pass", () => {
  assert.equal(compareFingerprint([null, 1, 2], qwen).verdict, "missing_usage");
  assert.equal(compareFingerprint(qwen, null).verdict, "no_reference");
});

test("fingerprint limit: same-tokenizer siblings collide (documented)", () => {
  assert.deepEqual(identify(qwen, refs).sort(), ["Qwen/Qwen3.8-27B", "Qwen/Qwen3.8-27B-abliterated"]);
});

test("all stable reference fingerprints in fingerprints.json", () => {
  for (const [m, r] of Object.entries(refs.models)) assert.ok(r.stable, `${m} unstable`);
});

const match = { verdict: "match" };
const att = (verdict, tee_capable = true) => ({ verdict, tee_capable, reason: verdict === "contradicts" ? "a TEE signature shows X answered" : undefined });

test("tiers: verified TEE + match = A", () => {
  assert.equal(decideTier({ fingerprint: match, attestation: att("verified"), capabilityPct: 100, errorPct: 0 }).tier, "A");
});

test("tiers: TEE contradiction is F even when the fingerprint matches (sibling swap)", () => {
  const d = decideTier({ fingerprint: match, attestation: att("contradicts"), capabilityPct: 100, errorPct: 0 });
  assert.equal(d.tier, "F");
  assert.equal(d.fingerprintOk, false);
});

test("tiers: a TEE-capable model without a signature caps at C", () => {
  assert.equal(decideTier({ fingerprint: match, attestation: att("unavailable", true), capabilityPct: 100, errorPct: 0 }).tier, "C");
});

test("tiers: a model with no TEE at the provider can reach B", () => {
  assert.equal(decideTier({ fingerprint: match, attestation: att("unavailable", false), capabilityPct: 75, errorPct: 0 }).tier, "B");
});

test("tiers: scaled usage is F with metering_ok false", () => {
  const d = decideTier({ fingerprint: { verdict: "scaled", factor: 1.35 }, attestation: att("unavailable"), capabilityPct: 100, errorPct: 0 });
  assert.equal(d.tier, "F");
  assert.equal(d.meteringOk, false);
  assert.equal(d.fingerprintOk, true, "same tokenizer, inflated billing");
});

test("tiers: low capability or errors lower the tier", () => {
  assert.equal(decideTier({ fingerprint: match, attestation: att("unavailable", false), capabilityPct: 25, errorPct: 0 }).tier, "C");
  assert.equal(decideTier({ fingerprint: match, attestation: att("verified"), capabilityPct: 100, errorPct: 60 }).tier, "F");
});

test("capability tasks are fresh per seed and checkable", () => {
  const a = capabilityTasks(7), b = capabilityTasks(8);
  assert.notEqual(a[0].prompt, b[0].prompt);
  const [mul] = a;
  const [x, y] = mul.prompt.match(/\d+/g).map(Number);
  assert.ok(mul.check(`thinking...\n${x * y}`));
  assert.ok(!mul.check(String(x * y + 1)));
});

test("price math matches the contract (round up, per 1M tokens)", () => {
  assert.equal(cost(1, 0, 1n, 0n), 1n);
  assert.equal(cost(1_000_000, 0, 7n, 0n), 7n);
  assert.equal(cost(1_000_001, 0, 1_000_000n, 0n), 1_000_001n);
  const order = { kind: "OnDemand", price_in: "3", price_out: "10" };
  assert.deepEqual(orderPrices(order, { ask_in: "2", ask_out: "20" }), [2n, 10n]);
  assert.deepEqual(orderPrices({ ...order, kind: "Spot" }, { ask_in: "2", ask_out: "20" }), [3n, 10n]);
});

test("receipts: valid signature verifies, an edited receipt does not", () => {
  const kp = KeyPair.fromRandom("ed25519");
  const r = signReceipt(kp, { listing: 1, order: 2, seq: 0, req: "a", resp: "b", in: 10, out: 20, ts: 1 });
  assert.ok(verifyReceipt(kp.getPublicKey().toString(), r.text, r.sig));
  assert.ok(!verifyReceipt(kp.getPublicKey().toString(), r.text.replace('"out":20', '"out":60'), r.sig));
  assert.equal(receiptsHash([r.text]).length, 64);
});

test("request signatures bind the order, time and body", () => {
  const kp = KeyPair.fromRandom("ed25519");
  const body = Buffer.from('{"model":"m"}');
  const h = signRequest(kp, "5", body, 1000);
  const sig = Buffer.from(h["x-ts-sig"], "base64");
  assert.ok(verifyEd25519(kp.getPublicKey().toString(), requestMessage("5", 1000, body), sig));
  assert.ok(!verifyEd25519(kp.getPublicKey().toString(), requestMessage("6", 1000, body), sig));
  assert.ok(!verifyEd25519(kp.getPublicKey().toString(), requestMessage("5", 1000, Buffer.from('{"model":"x"}')), sig));
});

test("EIP-191 recovery matches a real NEAR AI Cloud signature from the run", () => {
  const files = JSON.parse(readFileSync(new URL("./fixtures/tee-signature.json", import.meta.url)));
  assert.equal(recoverEip191(files.text, files.signature), files.signing_address.toLowerCase());
});

test("spot pricing rule moves the ask by bounded steps", () => {
  assert.equal(nextAsk(1000n, { fills: 3, targetFills: 1 }), 1100n);
  assert.equal(nextAsk(1000n, { fills: 0, targetFills: 1 }), 950n);
  assert.equal(nextAsk(1000n, { fills: 1, targetFills: 1 }), 1000n);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { judgeSignature, _pinAttested } from "../src/tee.js";

// A real signature NEAR AI Cloud returned for Qwen/Qwen3.8-27B (test/fixtures).
const fx = JSON.parse(readFileSync(new URL("./fixtures/tee-signature.json", import.meta.url)));
const [, reqHash, respHash] = [fx.text.split(":").slice(0, -2).join(":"), ...fx.text.split(":").slice(-2)];
const sig = { text: fx.text, signature: fx.signature, signing_address: fx.signing_address };
_pinAttested(fx.model, [fx.signing_address]);
_pinAttested("Qwen/Qwen3.6-35B-A3B-FP8", ["0x0000000000000000000000000000000000000001"]);

test("verified: the claimed model signed exactly the bytes the buyer saw", async () => {
  const v = await judgeSignature(sig, { model: fx.model, reqHash, respHash });
  assert.equal(v.verdict, "verified");
  assert.equal(v.signer, fx.signing_address.toLowerCase());
});

test("contradicts: an attested signature for another model than the one sold", async () => {
  _pinAttested("Qwen/Qwen3.9-72B", ["0x00000000000000000000000000000000000000aa"]);
  const v = await judgeSignature(sig, { model: "Qwen/Qwen3.9-72B", reqHash, respHash });
  assert.equal(v.verdict, "contradicts");
  assert.equal(v.signedModel, fx.model);
});

test("altered: the delivered answer is not the one the enclave signed", async () => {
  const v = await judgeSignature(sig, { model: fx.model, reqHash, respHash: "0".repeat(64) });
  assert.equal(v.verdict, "altered");
});

test("unsigned: no signature, a signer not in the report, or a broken signature", async () => {
  assert.equal((await judgeSignature(null, { model: fx.model, reqHash, respHash })).verdict, "unsigned");
  _pinAttested("Qwen/Lonely", []);
  const other = await judgeSignature({ ...sig, text: fx.text.replace(fx.model, "Qwen/Lonely") }, { model: "Qwen/Lonely", reqHash, respHash });
  assert.equal(other.verdict, "unsigned");
  assert.equal((await judgeSignature({ ...sig, signature: "0x" + "11".repeat(65) }, { model: fx.model, reqHash, respHash })).verdict, "unsigned");
});

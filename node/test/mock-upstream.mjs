#!/usr/bin/env node
// A stand-in for NEAR AI Cloud, for tests and dry runs of the live server
// without a real API key. NOT a model: it answers the grader's checkable tasks
// by parsing them and returns canned text otherwise.
//
// It imitates the parts of the provider Credster relies on:
// - POST /v1/chat/completions: prompt token counts equal the reference
//   fingerprints (node/fingerprints.json) for the probe texts, so the
//   fingerprint check behaves as it does against the real provider.
// - GET /v1/signature/<chat id>: an EIP-191 signature over
//   "<model>:sha256(request):sha256(response)", one signing key per model.
// - GET /v1/attestation/report?model=...: lists that model's signing address
//   (none for deepseek models, which have no TEE at the real provider either).
//
// usage: node test/mock-upstream.mjs [port]   then point the node and grader at it:
//   TS_UPSTREAM_URL=http://127.0.0.1:9100 TS_PROVIDER=http://127.0.0.1:9100 TS_UPSTREAM_KEY=mock
import http from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { FINGERPRINT_PROBES } from "../src/probes.js";

const refs = JSON.parse(readFileSync(new URL("../fingerprints.json", import.meta.url))).models;
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const enc = new TextEncoder();
const teeKey = (model) => createHash("sha256").update("credster-mock-tee:" + model).digest();
const address = (priv) => "0x" + Buffer.from(keccak_256(secp256k1.getPublicKey(priv, false).subarray(1)).subarray(12)).toString("hex");
const hasTee = (model) => !/deepseek/i.test(model);
const chats = new Map();
let n = 0;

function answer(content) {
  let m;
  if ((m = content.match(/Compute (\d+) \* (\d+)/))) return String(Number(m[1]) * Number(m[2]));
  if ((m = content.match(/Reverse the string "([a-z]+)"/))) return [...m[1]].reverse().join("");
  if ((m = content.match(/ascending order: ([\d, ]+)\./))) return m[1].split(",").map(Number).sort((a, b) => a - b).join(", ");
  if ((m = content.match(/letter "(.)" appear in "([a-z]+)"/))) return String([...m[2]].filter((c) => c === m[1]).length);
  return `(Mock upstream, not a model.) You asked: "${content.slice(0, 120)}". A real seller node forwards this to NEAR AI Cloud; this test double only counts tokens and signs the answer the same way.`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (status, obj) => { const body = Buffer.from(JSON.stringify(obj)); res.writeHead(status, { "content-type": "application/json" }); res.end(body); return body; };
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const j = JSON.parse(body);
    const content = String(j.messages?.at(-1)?.content ?? "");
    const probe = FINGERPRINT_PROBES.indexOf(content);
    const ref = refs[j.model];
    const prompt = probe >= 0 && ref ? ref.counts[probe] : Math.ceil(JSON.stringify(j.messages || []).length / 4) + 9;
    const text = probe >= 0 ? "Fingerprint noted." : answer(content);
    const id = `chatcmpl-mock-${Date.now().toString(36)}-${n++}`;
    const completion = Math.max(1, Math.ceil(text.length / 4));
    const out = Buffer.from(JSON.stringify({
      id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: j.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
    }));
    chats.set(id, { model: j.model, req: sha256(body), resp: sha256(out) });
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(out);
  }
  const sm = url.pathname.match(/^\/v1\/signature\/([^/]+)$/);
  if (req.method === "GET" && sm) {
    const c = chats.get(decodeURIComponent(sm[1]));
    if (!c || !hasTee(c.model)) return send(404, { error: "no signature for this chat" });
    const text = `${c.model}:${c.req}:${c.resp}`;
    const msg = enc.encode(text);
    const digest = keccak_256(new Uint8Array([...enc.encode(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]));
    const priv = teeKey(c.model);
    const rec = secp256k1.sign(digest, priv, { prehash: false, format: "recovered" }); // [v, r(32), s(32)]
    const sigHex = Buffer.from([...rec.subarray(1), rec[0] + 27]).toString("hex");
    return send(200, { text, signature: "0x" + sigHex, signing_address: address(priv), signing_algo: "ecdsa" });
  }
  if (req.method === "GET" && url.pathname === "/v1/attestation/report") {
    const model = url.searchParams.get("model") || "";
    if (!hasTee(model)) return send(404, { error: "model has no TEE attestation" });
    return send(200, { model_attestations: [{ signing_address: address(teeKey(model)) }] });
  }
  send(404, { error: "not found" });
});
const port = Number(process.argv[2] || 9100);
server.listen(port, "127.0.0.1", () => console.log(`mock upstream on http://127.0.0.1:${port}`));

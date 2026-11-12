#!/usr/bin/env node
// credster <command> [--flag value ...]
import { view, call, near, fmtNear } from "./near.js";

const [cmd, ...rest] = process.argv.slice(2);
const a = {};
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith("--")) continue;
  const k = rest[i].slice(2);
  const next = rest[i + 1];
  if (next === undefined || next.startsWith("--")) a[k] = true;
  else { a[k] = next; i++; }
}

const need = (k) => {
  if (a[k] === undefined || a[k] === true) throw new Error(`missing --${k}`);
  return a[k];
};
const nearPerM = (s) => near(s).toString(); // "0.2" NEAR per 1M tokens -> yocto

const commands = {
  async fingerprint() {
    const { buildFingerprints } = await import("./grader.js");
    const key = process.env.NEARAI_API_KEY;
    if (!key) throw new Error("set NEARAI_API_KEY (reference calls go straight to NEAR AI Cloud)");
    await buildFingerprints(need("models").split(","), key);
  },

  async "seller-list"() {
    const { createListing } = await import("./seller-node.js");
    const r = await createListing({
      name: need("name"),
      seller: need("seller"),
      model: need("model"),
      endpoint: need("endpoint"),
      askIn: nearPerM(need("ask-in")),
      askOut: nearPerM(need("ask-out")),
      capacity: a.capacity || "5000000",
      bond: near(a.bond || "0.5"),
    });
    console.log(JSON.stringify(r));
  },

  async "seller-serve"() {
    const { startSellerNode } = await import("./seller-node.js");
    startSellerNode({
      name: need("name"),
      port: Number(need("port")),
      upstreamKey: process.env.TS_UPSTREAM_KEY,
      mode: a.mode || "honest",
      swapModel: a["swap-model"],
      inflate: a.inflate ? Number(a.inflate) : 1.35,
      claimEverySec: a["claim-every"] ? Number(a["claim-every"]) : 20,
    });
  },

  async grade() {
    const { gradeListing } = await import("./grader.js");
    const r = await gradeListing(need("listing"), { grader: need("grader"), post: a["no-post"] ? false : true });
    console.log(JSON.stringify({ tier: r.report.decision.tier, hash: r.hash, file: r.file, tx: r.tx }));
  },

  async resolve() {
    const { resolveDisputes } = await import("./grader.js");
    console.log(JSON.stringify(await resolveDisputes({ grader: need("grader") }), null, 2));
  },

  async listings() {
    const ls = await view("get_listings", { from: 0, limit: 100 });
    for (const l of ls) {
      const g = l.grade;
      console.log(`#${l.id} ${l.model.padEnd(28)} ${l.status.padEnd(9)} grade ${g ? g.tier + " " + g.score : "-"}  ask ${fmtNear(l.ask_in, 4)}/${fmtNear(l.ask_out, 4)} NEAR per 1M  seller ${l.seller}`);
    }
  },

  async "buy-spot"() {
    const { Buyer } = await import("./buyer.js");
    const r = await new Buyer(need("buyer")).buySpot(need("listing"), near(need("deposit")));
    console.log(JSON.stringify(r));
  },

  async chat() {
    const { Buyer } = await import("./buyer.js");
    const order = await view("get_order", { order_id: String(need("order")) });
    const listing = await view("get_listing", { listing_id: order.listing_id });
    const r = await new Buyer(need("buyer")).chat(need("order"), { model: listing.model, messages: [{ role: "user", content: need("prompt") }], max_tokens: Number(a["max-tokens"] || 512) });
    if (!r.ok) throw new Error(`${r.status} ${r.error}`);
    console.log(r.json.choices[0].message.content);
    console.error(`receipt ${r.receiptOk ? "verified" : "INVALID"}: ${r.receipt.in} in / ${r.receipt.out} out, ${r.ms} ms`);
  },

  async audit() {
    const { Buyer } = await import("./buyer.js");
    const b = new Buyer(need("buyer"));
    const r = await b.audit(need("order"));
    console.log(JSON.stringify({ receipts: r.receipts, haveIn: r.haveIn, haveOut: r.haveOut, claims: r.claims.map((c) => ({ id: c.id, in: c.in_tokens, out: c.out_tokens, status: c.status })), bad: r.bad.map((x) => ({ id: x.claim.id, reason: x.reason })) }, null, 2));
    if (a.dispute) for (const x of r.bad) console.log("disputed", x.claim.id, (await b.dispute(x.claim.id, x.reason)).txHash);
  },

  /** Keyless check: every local grade report hashes to the report_hash on chain. */
  async "verify-reports"() {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { sha256hex } = await import("./sign.js");
    const { REPORTS } = await import("./grader.js");
    let bad = 0;
    for (const l of await view("get_listings", { from: 0, limit: 100 })) {
      if (!l.grade) continue;
      const file = join(REPORTS, l.grade.report_url.replace(/^reports\//, ""));
      if (!existsSync(file)) { console.log(`#${l.id} ${l.grade.tier}: report file not in this checkout`); continue; }
      const text = readFileSync(file, "utf8");
      const ok = sha256hex(text) === l.grade.report_hash;
      const r = JSON.parse(text);
      if (!ok) bad++;
      console.log(`#${l.id} ${l.model} grade ${l.grade.tier}: report hash ${ok ? "matches chain" : "MISMATCH"}; fingerprint ${r.fingerprint.verdict}, TEE ${r.attestation.verdict}${r.decision.reasons.length ? "; " + r.decision.reasons.join("; ") : ""}`);
    }
    if (bad) process.exit(1);
  },

  async finalize() {
    const claims = await view("get_claims", { from: 0, limit: 100 });
    const cfg = await view("get_config");
    const now = Date.now() * 1e6;
    for (const c of claims) {
      if (c.status === "Pending" && Number(c.submitted_at) + cfg.challenge_window_sec * 1e9 <= now) {
        const r = await call(need("signer"), "finalize_claim", { claim_id: c.id });
        console.log(`claim ${c.id} paid ${fmtNear(c.amount)} NEAR tx ${r.txHash}`);
      }
    }
  },
};

if (!commands[cmd]) {
  console.error(`usage: credster <${Object.keys(commands).join("|")}> [--flags]`);
  process.exit(2);
}
commands[cmd]().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

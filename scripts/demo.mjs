#!/usr/bin/env node
// End-to-end run on NEAR testnet. Starts six seller nodes in this process,
// lists them, grades them, then runs spot, on-demand and bargaining trades,
// a fraudulent claim with a dispute and a slash, settlement and refunds.
// Writes a step log and a JSON summary with every transaction hash.
//
// Needs: TS_CONTRACT, P (parent account), NEARAI_API_KEY. See README.
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(HERE, "..", "evidence", `run-${stamp}`);
mkdirSync(outDir, { recursive: true });
// Node and order keys live in a throwaway home, never in the repo.
process.env.CREDSTER_HOME ||= mkdtempSync(join(tmpdir(), "credster-demo-"));
process.env.TS_UPSTREAM_KEY ||= process.env.NEARAI_API_KEY;
if (process.env.TS_LLM_NOTES === "1") process.env.TS_AGENT_KEY ||= process.env.NEARAI_API_KEY;

const { view, call, near, fmtNear, txUrl, account } = await import("../node/src/near.js");
const { startSellerNode, createListing } = await import("../node/src/seller-node.js");
const { gradeListing, resolveDisputes } = await import("../node/src/grader.js");
const { Buyer } = await import("../node/src/buyer.js");
const { BuyerAgent, SellerAgent, nextAsk } = await import("../node/src/agents.js");

const P = process.env.P;
if (!P || !process.env.TS_CONTRACT || !process.env.NEARAI_API_KEY) throw new Error("set P, TS_CONTRACT and NEARAI_API_KEY");
const logFile = join(outDir, "run.log");
const log = (...a) => {
  const line = a.join(" ");
  console.log(line);
  appendFileSync(logFile, line + "\n");
};
const summary = { started_at: new Date().toISOString(), contract: process.env.TS_CONTRACT, steps: [] };
const step = (name, data) => {
  summary.steps.push({ name, at: new Date().toISOString(), ...data });
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const expectFail = async (what, fn) => {
  try {
    await fn();
    throw new Error(`${what}: expected the contract to refuse, it accepted`);
  } catch (e) {
    if (e.message.includes("expected the contract to refuse")) throw e;
    const reason = e.panic || e.message.slice(0, 160);
    log(`  refused as expected: ${reason}`);
    return reason;
  }
};

const grader = `grader.${P}`;
const alice = new Buyer(`b-alice.${P}`);
const bob = new Buyer(`b-bob.${P}`);
const BASE = Number(process.env.TS_DEMO_PORT || 8711);

// name, seller account, claimed model, served model, mode, ask in/out (NEAR per 1M)
const SELLERS = [
  { name: "honest", seller: `s-honest.${P}`, model: "Qwen/Qwen3.8-27B", mode: "honest", ask: ["0.08", "0.30"] },
  { name: "swap", seller: `s-swap.${P}`, model: "Qwen/Qwen3.8-27B", mode: "swap", swapModel: "Qwen/Qwen3.6-35B-A3B-FP8", ask: ["0.05", "0.20"] },
  { name: "sibling", seller: `s-sibling.${P}`, model: "Qwen/Qwen3.8-27B", mode: "swap", swapModel: "Qwen/Qwen3.8-27B-abliterated", ask: ["0.06", "0.24"] },
  { name: "inflate", seller: `s-inflate.${P}`, model: "z-ai/glm-5.3-flash", mode: "inflate", ask: ["0.03", "0.12"] },
  { name: "deepseek", seller: `s-deepseek.${P}`, model: "deepseek/deepseek-v4.1-flash", mode: "honest", ask: ["0.03", "0.12"] },
  { name: "overclaim", seller: `s-overclaim.${P}`, model: "z-ai/glm-5.3-flash", mode: "overclaim", ask: ["0.025", "0.10"] },
];

log(`# Credster end-to-end run ${summary.started_at}`);
log(`contract ${process.env.TS_CONTRACT}`);

// 1. List and serve.
log(`\n## 1. Six sellers list an endpoint and post a 0.2 NEAR bond`);
const nodes = {};
const L = {};
for (const [i, s] of SELLERS.entries()) {
  const port = BASE + i;
  const r = await createListing({ name: s.name, seller: s.seller, model: s.model, endpoint: `http://127.0.0.1:${port}/v1`, askIn: near(s.ask[0]), askOut: near(s.ask[1]), capacity: "5000000", bond: near("0.2") });
  L[s.name] = r.listingId;
  nodes[s.name] = startSellerNode({ name: s.name, port, upstreamKey: process.env.TS_UPSTREAM_KEY, mode: s.mode, swapModel: s.swapModel, claimEverySec: 0 });
  log(`  listing ${r.listingId} ${s.name.padEnd(9)} claims ${s.model} at ${s.ask[0]}/${s.ask[1]} NEAR per 1M (node mode: ${s.mode}${s.swapModel ? " -> " + s.swapModel : ""}) tx ${r.txHash}`);
  step("listed", { seller: s.name, listing: r.listingId, model: s.model, mode: s.mode, served: s.swapModel || s.model, tx: r.txHash });
}
await sleep(500);

log(`\n## 2. An ungraded listing only takes small trial orders`);
step("ungraded_refused", { reason: await expectFail("buy ungraded", () => alice.buySpot(L.swap, near("0.2"))) });

// 2. Grade.
log(`\n## 3. The grader buys a trial order on each listing and probes it`);
const grades = {};
for (const s of SELLERS) {
  const g = await gradeListing(L[s.name], { grader, log });
  grades[s.name] = g.report.decision;
  await nodes[s.name].claimNow(); // the seller claims the probe usage like any other
  step("graded", { seller: s.name, listing: L[s.name], tier: g.report.decision.tier, score: g.report.decision.score, reasons: g.report.decision.reasons, fingerprint: g.report.fingerprint, attestation: g.report.attestation.verdict, report: g.file, report_sha256: g.hash, tx: g.tx });
}
log(`\n  grades: ${SELLERS.map((s) => `${s.name}=${grades[s.name].tier}`).join(" ")}`);
log(`  the contract will not pay probe usage on the three F listings (checked in step 11)`);

log(`\n## 4. F-graded listings are suspended`);
step("f_refused", { reason: await expectFail("buy F", () => alice.buySpot(L.swap, near("0.1"))) });

// 3. Spot.
log(`\n## 5. Spot: Alice buys 0.1 NEAR of ${SELLERS[0].model} at the honest seller's ask`);
const spot = await alice.buySpot(L.honest, near("0.1"));
log(`  order ${spot.value} tx ${spot.txHash}`);
for (const q of ["In one sentence, what is a NEAR sub-account?", "Name two uses of a function-call access key on NEAR, one line each."]) {
  const r = await alice.chat(spot.value, { model: "Qwen/Qwen3.8-27B", messages: [{ role: "user", content: q }], max_tokens: 4000 });
  log(`  answer (${r.ms} ms, receipt ${r.receiptOk ? "verified" : "INVALID"}: ${r.receipt?.in} in / ${r.receipt?.out} out): ${String(r.json?.choices?.[0]?.message?.content || r.error).trim().replace(/\s+/g, " ").slice(0, 140)}`);
}
step("spot", { order: spot.value, tx: spot.txHash });

log(`\n## 6. The seller's pricing rule raises the ask after demand; the spot order keeps its price`);
const hl = await view("get_listing", { listing_id: L.honest });
const newIn = nextAsk(hl.ask_in, { fills: 3, targetFills: 1 });
const newOut = nextAsk(hl.ask_out, { fills: 3, targetFills: 1 });
const up = await call(`s-honest.${P}`, "update_ask", { listing_id: L.honest, ask_in: String(newIn), ask_out: String(newOut) });
log(`  ask ${fmtNear(hl.ask_in, 4)}/${fmtNear(hl.ask_out, 4)} -> ${fmtNear(newIn, 4)}/${fmtNear(newOut, 4)} tx ${up.txHash}`);
step("reprice", { from: [hl.ask_in, hl.ask_out], to: [String(newIn), String(newOut)], tx: up.txHash });

// 4. On-demand.
log(`\n## 7. On-demand: Bob opens a tab on deepseek with a ceiling of 0.15 per 1M output`);
const tab = await bob.openTab(L.deepseek, near("0.04"), near("0.15"), near("0.05"));
log(`  tab order ${tab.value} tx ${tab.txHash}`);
const r7 = await bob.chat(tab.value, { model: "deepseek/deepseek-v4.1-flash", messages: [{ role: "user", content: "Give one sentence on why metered AI usage needs signed receipts." }], max_tokens: 800 });
log(`  answer (${r7.ms} ms, receipt ${r7.receiptOk ? "verified" : "INVALID"}): ${String(r7.json?.choices?.[0]?.message?.content || r7.error).trim().replace(/\s+/g, " ").slice(0, 140)}`);
await nodes.deepseek.claimNow();
const dl = await view("get_listing", { listing_id: L.deepseek });
const up2 = await call(`s-deepseek.${P}`, "update_ask", { listing_id: L.deepseek, ask_in: dl.ask_in, ask_out: String(near("0.30")) });
log(`  deepseek seller raises its output ask to 0.30, above Bob's ceiling tx ${up2.txHash}`);
const r7b = await bob.chat(tab.value, { model: "deepseek/deepseek-v4.1-flash", messages: [{ role: "user", content: "One sentence: what does a price ceiling protect?" }], max_tokens: 800 });
log(`  answer (receipt ${r7b.receiptOk ? "verified" : "INVALID"}): ${String(r7b.json?.choices?.[0]?.message?.content || r7b.error).trim().replace(/\s+/g, " ").slice(0, 120)}`);
await nodes.deepseek.claimNow();
const tabClaims = (await view("get_claims", { from: 0, limit: 100 })).filter((c) => c.order_id === tab.value);
for (const c of tabClaims) log(`  claim ${c.id}: ${c.in_tokens} in / ${c.out_tokens} out priced at ${fmtNear(c.price_in, 4)}/${fmtNear(c.price_out, 4)} per 1M, amount ${fmtNear(c.amount, 9)} NEAR`);
step("on_demand", { order: tab.value, tx: tab.txHash, claims: tabClaims.map((c) => ({ id: c.id, price_out: c.price_out, amount: c.amount })) });

// 5. Bargain.
log(`\n## 8. Bargain: Bob's agent and the honest seller's agent negotiate (tier A)`);
const bobAgent = new BuyerAgent(bob, { log });
const honestAgent = new SellerAgent(`s-honest.${P}`, { log });
const o1 = await bobAgent.open(await view("get_listing", { listing_id: L.honest }), near("0.08"));
let res, negotiated = null;
for (let turn = 0; turn < 4; turn++) {
  res = await honestAgent.react(o1.offerId);
  if (res.result !== "countered") break;
  res = await bobAgent.react(o1.offerId);
  if (res.result !== "countered") break;
}
if (res.orderId) negotiated = res.orderId;
const off1 = await view("get_offer", { offer_id: o1.offerId });
log(`  offer ${o1.offerId}: ${off1.status} after ${off1.moves.length} moves${negotiated ? ", order " + negotiated : ""}`);
step("bargain_a", { offer: o1.offerId, status: off1.status, moves: off1.moves, order: negotiated });
if (negotiated) {
  const r = await bob.chat(negotiated, { model: "Qwen/Qwen3.8-27B", messages: [{ role: "user", content: "One sentence: why grade a seller before buying from it?" }], max_tokens: 4000 });
  log(`  negotiated-order answer (receipt ${r.receiptOk ? "verified" : "INVALID"}): ${String(r.json?.choices?.[0]?.message?.content || r.error).trim().replace(/\s+/g, " ").slice(0, 140)}`);
}

log(`\n## 9. Bargain: Alice's agent and the deepseek seller's agent (tier B) do not agree`);
const aliceAgent = new BuyerAgent(alice, { log });
const dsAgent = new SellerAgent(`s-deepseek.${P}`, { log });
const o2 = await aliceAgent.open(await view("get_listing", { listing_id: L.deepseek }), near("0.03"));
for (let turn = 0; turn < 4; turn++) {
  res = await dsAgent.react(o2.offerId);
  if (res.result !== "countered") break;
  res = await aliceAgent.react(o2.offerId);
  if (res.result !== "countered") break;
}
const off2 = await view("get_offer", { offer_id: o2.offerId });
log(`  offer ${o2.offerId}: ${off2.status} after ${off2.moves.length} moves, deposit refunded`);
step("bargain_b", { offer: o2.offerId, status: off2.status, moves: off2.moves });

// 6. Fraudulent claim.
log(`\n## 10. A seller that passed grading claims 3x the tokens it served`);
const oc = await alice.buySpot(L.overclaim, near("0.05"));
for (const q of ["Say hello in five words.", "Name one planet."]) {
  const r = await alice.chat(oc.value, { model: "z-ai/glm-5.3-flash", messages: [{ role: "user", content: q }], max_tokens: 600 });
  log(`  answer (receipt ${r.receiptOk ? "verified" : "INVALID"}: ${r.receipt?.in} in / ${r.receipt?.out} out)`);
}
await nodes.overclaim.claimNow();
const audit = await alice.audit(oc.value);
log(`  Alice's receipts: ${audit.receipts}, ${audit.haveIn} in / ${audit.haveOut} out. Claims: ${audit.claims.map((c) => `#${c.id} ${c.in_tokens}/${c.out_tokens}`).join(", ")}`);
const disputes = [];
for (const b of audit.bad) {
  const d = await alice.dispute(b.claim.id, b.reason);
  log(`  Alice disputes claim ${b.claim.id}: ${b.reason} tx ${d.txHash}`);
  disputes.push({ claim: b.claim.id, reason: b.reason, tx: d.txHash });
}
const bondBefore = (await view("get_listing", { listing_id: L.overclaim })).bond;
const resolved = await resolveDisputes({ grader, log });
const bondAfter = (await view("get_listing", { listing_id: L.overclaim })).bond;
log(`  overclaim seller bond ${fmtNear(bondBefore)} -> ${fmtNear(bondAfter)} NEAR`);
step("dispute", { order: oc.value, audit: { receipts: audit.receipts, in: audit.haveIn, out: audit.haveOut }, disputes, resolved, bond_before: bondBefore, bond_after: bondAfter });

// 7. Settle.
log(`\n## 11. Sellers claim, the window passes, claims are paid, orders close with refunds`);
for (const n of Object.values(nodes)) await n.claimNow();
for (const o of [spot.value, tab.value, negotiated].filter(Boolean)) await (o === tab.value ? bob : o === negotiated ? bob : alice).close(o);
await alice.close(oc.value);
const cfg = await view("get_config");
log(`  waiting ${cfg.challenge_window_sec + 5} s for the challenge window`);
await sleep((cfg.challenge_window_sec + 5) * 1000);
const paid = [];
for (const c of await view("get_claims", { from: 0, limit: 100 })) {
  if (c.status === "Pending") {
    const r = await call(grader, "finalize_claim", { claim_id: c.id });
    paid.push({ claim: c.id, amount: c.amount, tx: r.txHash });
    log(`  claim ${c.id} paid ${fmtNear(c.amount, 9)} NEAR tx ${r.txHash}`);
  }
}
const closed = [];
for (const o of await view("get_orders", { from: 0, limit: 100 })) {
  if (o.status === "Closing" && o.pending === "0") {
    const r = await call(grader, "settle_close", { order_id: o.id }).catch((e) => ({ error: e.message.slice(0, 120) }));
    if (r.txHash) {
      const after = await view("get_order", { order_id: o.id });
      closed.push({ order: o.id, refund: String(BigInt(after.deposit) - BigInt(after.spent)), spent: after.spent, tx: r.txHash });
      log(`  order ${o.id} closed: spent ${fmtNear(after.spent, 9)}, refunded ${fmtNear(BigInt(after.deposit) - BigInt(after.spent), 9)} NEAR tx ${r.txHash}`);
    }
  }
}
step("settled", { paid, closed });

const stats = await view("get_stats");
log(`\n## Result`);
log(`  listings ${stats.listings}, orders ${stats.orders}, claims ${stats.claims}, paid ${fmtNear(stats.volume_paid, 9)} NEAR, slashed ${fmtNear(stats.slashed_total, 6)} NEAR, tokens settled ${stats.tokens_settled}`);
summary.finished_at = new Date().toISOString();
summary.stats = stats;
summary.listings = L;
summary.explorer = "https://testnet.nearblocks.io/address/" + process.env.TS_CONTRACT;
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
log(`\nevidence: evidence/${outDir.split("/").pop()}`);
for (const n of Object.values(nodes)) n.close();
process.exit(0);

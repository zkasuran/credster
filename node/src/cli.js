#!/usr/bin/env node
// credster <command> [--flag value ...]   (credster help lists them)
import { view, viewAll, call, near, fmtNear, txUrl, saveKey, newKeyPair, balance, CRED_DIR, NETWORK } from "./near.js";

const [cmd, ...rest] = process.argv.slice(2);
const a = {};
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith("--")) continue;
  const k = rest[i].slice(2);
  const next = rest[i + 1];
  if (next === undefined || next.startsWith("--")) a[k] = true;
  else { a[k] = next; i++; }
}

// Keeps reasoning models' thinking short so the answer fits the token cap (see web/site/js/live.js).
const briefFor = (model) => (String(model).startsWith("z-ai/") ? { reasoning_effort: "low" } : String(model).startsWith("Qwen/") ? { chat_template_kwargs: { enable_thinking: false } } : {});
const need = (k) => {
  if (a[k] === undefined || a[k] === true) throw new Error(`missing --${k}`);
  return a[k];
};
const nearPerM = (s) => near(s).toString(); // "0.2" NEAR per 1M tokens -> yocto
const perM = (y) => fmtNear(y, 4);
const out = (x) => console.log(typeof x === "string" ? x : JSON.stringify(x, null, 2));
const tx = (r) => (r?.txHash ? `tx ${r.txHash}  ${txUrl(r.txHash)}` : "");

const HELP = {
  // accounts
  "new-account": "[--name prefix] [--faucet https://live-server]  create a testnet account and save its key (testnet faucet: 10 NEAR; --faucet: an implicit account funded by a Credster live server)",
  balance: "--account ID",
  // seller
  "seller-list": "--name N --seller ACCT --model M --endpoint URL --ask-in NEAR --ask-out NEAR [--capacity T] [--bond NEAR]",
  "seller-serve": "--name N --port P [--host 127.0.0.1] [--upstream URL] [--mode honest|swap|inflate|overclaim] [--swap-model M] [--inflate 1.35] [--claim-every SEC]   (needs TS_UPSTREAM_KEY)",
  "update-endpoint": "--name N --endpoint URL   (new node key on chain; the grade is cleared until graded again)",
  "update-ask": "--name N --ask-in NEAR --ask-out NEAR",
  "close-listing": "--name N   (no open orders or offers; returns the bond)",
  // buyer
  listings: "",
  "buy-spot": "--buyer ACCT --listing ID --deposit NEAR",
  "open-tab": "--buyer ACCT --listing ID --ceiling-in NEAR --ceiling-out NEAR --deposit NEAR",
  "make-offer": "--buyer ACCT --listing ID --price-in NEAR --price-out NEAR --deposit NEAR [--note TEXT] [--ttl SEC]",
  offer: "--offer ID   (show the moves)",
  counter: "--as ACCT --offer ID --price-in NEAR --price-out NEAR [--note TEXT]   (buyer or seller)",
  accept: "--as ACCT --offer ID   (buyer or seller; opens the order)",
  "end-offer": "--as ACCT --offer ID   (withdraw, reject, or expire; refunds the deposit)",
  chat: "--buyer ACCT --order ID --prompt TEXT [--max-tokens 512] [--endpoint URL]",
  orders: "[--buyer ACCT] [--listing ID]",
  claims: "[--order ID]",
  audit: "--buyer ACCT --order ID [--dispute]",
  close: "--buyer ACCT --order ID   (the seller has one challenge window to claim, then settle)",
  settle: "--signer ACCT --order ID   (anyone, after the window: refunds the unspent deposit)",
  finalize: "--signer ACCT   (anyone: pays undisputed claims whose window passed)",
  // grader and operators
  fingerprint: "--models a,b   (needs NEARAI_API_KEY)",
  grade: "--listing ID --grader ACCT [--no-post]",
  resolve: "--grader ACCT",
  keeper: "--grader ACCT [--signer ACCT]   (grading, settlement and disputes in a loop, without hosting nodes)",
  live: "(env: TS_CONTRACT, TS_PUBLIC_URL, TS_UPSTREAM_KEY, ...; see JUDGING.md)   web site + hosted seller nodes + keeper + faucet",
  "verify-reports": "   (keyless: local report files against report_hash on chain)",
};

async function nodeConf(name) {
  const { path, readJson } = await import("./store.js");
  const conf = readJson(path("nodes", name, "node.json"));
  if (!conf?.listing_id && conf?.listing_id !== 0) throw new Error(`no listed node ${name} in this CREDSTER_HOME`);
  return conf;
}

async function claimsOf(orderId) {
  return (await viewAll("get_claims")).filter((c) => !orderId || String(c.order_id) === String(orderId));
}

const commands = {
  async help() {
    console.log("usage: credster <command> [--flags]   (network " + NETWORK + ", keys in " + CRED_DIR + ")\n");
    for (const [c, h] of Object.entries(HELP)) console.log(`  ${c.padEnd(16)} ${h}`);
  },

  async "new-account"() {
    const kp = newKeyPair();
    if (a.faucet) {
      const { keyToImplicitAddress } = await import("near-api-js");
      const id = keyToImplicitAddress(kp.getPublicKey());
      saveKey(id, kp);
      const r = await fetch(`${String(a.faucet).replace(/\/$/, "")}/api/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account_id: id }) });
      const j = await r.json();
      if (!r.ok) throw new Error(`faucet: ${j.error}`);
      out(`account ${id}\nfunded with ${fmtNear(j.amount, 2)} NEAR ${txUrl(j.tx)}\nkey saved in ${CRED_DIR}`);
      return;
    }
    const id = `${a.name || "credster-judge"}-${Date.now().toString(36)}.testnet`;
    saveKey(id, kp);
    const r = await fetch(process.env.TS_HELPER_URL || "https://helper.nearprotocol.com/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }) });
    if (!r.ok) throw new Error(`testnet faucet ${r.status}: ${(await r.text()).slice(0, 200)}`);
    for (let i = 0; i < 20 && (await balance(id)) === null; i++) await new Promise((s) => setTimeout(s, 1500));
    out(`account ${id} (${fmtNear((await balance(id)) || 0n, 2)} NEAR)\nkey saved in ${CRED_DIR}`);
  },

  async balance() {
    const b = await balance(need("account"));
    out(b === null ? "no such account" : `${fmtNear(b, 6)} NEAR`);
  },

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
    out(r);
  },

  async "seller-serve"() {
    const { startSellerNode } = await import("./seller-node.js");
    startSellerNode({
      name: need("name"),
      port: Number(need("port")),
      host: a.host || "127.0.0.1",
      upstream: a.upstream || process.env.TS_UPSTREAM_URL || "https://cloud-api.near.ai",
      upstreamKey: process.env.TS_UPSTREAM_KEY,
      mode: a.mode || "honest",
      swapModel: a["swap-model"],
      inflate: a.inflate ? Number(a.inflate) : 1.35,
      claimEverySec: a["claim-every"] ? Number(a["claim-every"]) : 20,
      maxTokens: a["max-tokens"] ? Number(a["max-tokens"]) : Infinity,
    });
  },

  async "update-endpoint"() {
    const { moveListing } = await import("./seller-node.js");
    out(`moved: ${tx(await moveListing(need("name"), need("endpoint")))}`);
  },

  async "update-ask"() {
    const c = await nodeConf(need("name"));
    out(tx(await call(c.seller, "update_ask", { listing_id: String(c.listing_id), ask_in: nearPerM(need("ask-in")), ask_out: nearPerM(need("ask-out")) })));
  },

  async "close-listing"() {
    const c = await nodeConf(need("name"));
    out(`listing ${c.listing_id} closed, bond returned: ${tx(await call(c.seller, "close_listing", { listing_id: String(c.listing_id) }))}`);
  },

  async grade() {
    const { gradeListing } = await import("./grader.js");
    const r = await gradeListing(need("listing"), { grader: need("grader"), post: a["no-post"] ? false : true });
    out({ tier: r.report.decision.tier, hash: r.hash, file: r.file, tx: r.tx });
  },

  async resolve() {
    const { resolveDisputes } = await import("./grader.js");
    out(await resolveDisputes({ grader: need("grader") }));
  },

  async keeper() {
    const { createKeeper } = await import("./keeper.js");
    createKeeper({ grader: need("grader"), signer: a.signer || a.grader }).start();
  },

  async live() {
    const { join } = await import("node:path");
    const { HOME } = await import("./store.js");
    process.env.TS_REPORTS ||= join(HOME, "reports");
    if (process.env.TS_PUBLIC_URL) process.env.TS_REPORT_BASE_URL ||= process.env.TS_PUBLIC_URL.replace(/\/$/, "") + "/reports";
    const { startLive } = await import("./live.js");
    await startLive();
  },

  async listings() {
    for (const l of await viewAll("get_listings")) {
      const g = l.grade;
      console.log(`#${l.id} ${l.model.padEnd(30)} ${l.status.padEnd(9)} grade ${g ? g.tier + " " + String(g.score).padStart(3) : "-    "}  ask ${perM(l.ask_in)}/${perM(l.ask_out)} NEAR per 1M  seller ${l.seller}  ${l.endpoint}`);
    }
  },

  async "buy-spot"() {
    const { Buyer } = await import("./buyer.js");
    const r = await new Buyer(need("buyer")).buySpot(need("listing"), near(need("deposit")));
    out(`order ${r.value}  ${tx(r)}`);
  },

  async "open-tab"() {
    const { Buyer } = await import("./buyer.js");
    const r = await new Buyer(need("buyer")).openTab(need("listing"), nearPerM(need("ceiling-in")), nearPerM(need("ceiling-out")), near(need("deposit")));
    out(`tab order ${r.value}  ${tx(r)}`);
  },

  async "make-offer"() {
    const { Buyer } = await import("./buyer.js");
    const r = await new Buyer(need("buyer")).makeOffer(need("listing"), nearPerM(need("price-in")), nearPerM(need("price-out")), String(a.note || "Offer from the CLI."), near(need("deposit")), Number(a.ttl || 900));
    out(`offer ${r.value}  ${tx(r)}\nwatch it: credster offer --offer ${r.value}`);
  },

  async offer() {
    const o = await view("get_offer", { offer_id: String(need("offer")) });
    if (!o) throw new Error("no such offer");
    out(`offer ${o.id} on listing ${o.listing_id} by ${o.buyer}: ${o.status}${o.order_id ? " -> order " + o.order_id : ""}, deposit ${fmtNear(o.deposit, 4)} NEAR`);
    for (const m of o.moves) console.log(`  ${m.by.padEnd(6)} ${perM(m.price_in)} / ${perM(m.price_out)}  ${m.note}`);
  },

  async counter() {
    const { Buyer } = await import("./buyer.js");
    out(tx(await new Buyer(need("as")).counter(need("offer"), nearPerM(need("price-in")), nearPerM(need("price-out")), a.note || "Counter from the CLI.")));
  },

  async accept() {
    const { Buyer } = await import("./buyer.js");
    const r = await new Buyer(need("as")).accept(need("offer"));
    out(`order ${r.value}  ${tx(r)}`);
  },

  async "end-offer"() {
    out(tx(await call(need("as"), "end_offer", { offer_id: String(need("offer")) })));
  },

  async chat() {
    const { Buyer } = await import("./buyer.js");
    const order = await view("get_order", { order_id: String(need("order")) });
    const listing = await view("get_listing", { listing_id: order.listing_id });
    const r = await new Buyer(need("buyer")).chat(need("order"), { model: listing.model, messages: [{ role: "user", content: need("prompt") }], max_tokens: Number(a["max-tokens"] || 1024), ...briefFor(listing.model) }, { endpoint: a.endpoint, tee: true });
    if (!r.ok) throw new Error(`${r.status} ${r.error}`);
    console.log(r.json.choices[0].message.content);
    if (r.tee) console.error(r.tee.verdict === "verified" ? `TEE: answered by ${r.tee.signedModel} (enclave signer ${r.tee.signer})` : r.tee.verdict === "none" ? "TEE: no TEE signatures for this model" : `TEE ${r.tee.verdict}: ${r.tee.reason}`);
    console.error(`receipt ${r.receiptOk ? "verified" : "INVALID"}: ${r.receipt.in} in / ${r.receipt.out} out, ${r.ms} ms`);
  },

  async orders() {
    for (const o of await viewAll("get_orders")) {
      if (a.buyer && o.buyer !== a.buyer) continue;
      if (a.listing && String(o.listing_id) !== String(a.listing)) continue;
      console.log(`#${o.id} listing ${o.listing_id} ${o.kind}${o.trial ? " (trial)" : ""} ${o.status.padEnd(7)} price ${perM(o.price_in)}/${perM(o.price_out)}  deposit ${fmtNear(o.deposit, 4)} spent ${fmtNear(o.spent, 6)} pending ${fmtNear(o.pending, 6)}  ${o.buyer}`);
    }
  },

  async claims() {
    for (const c of await claimsOf(a.order)) {
      console.log(`#${c.id} order ${c.order_id} ${c.in_tokens} in / ${c.out_tokens} out  ${fmtNear(c.amount, 9)} NEAR  ${c.status}${c.slashed !== "0" ? " slashed " + fmtNear(c.slashed, 4) : ""}${c.resolution ? "  " + c.resolution : ""}`);
    }
  },

  async audit() {
    const { Buyer } = await import("./buyer.js");
    const b = new Buyer(need("buyer"));
    const r = await b.audit(need("order"));
    out({ receipts: r.receipts, haveIn: r.haveIn, haveOut: r.haveOut, claims: r.claims.map((c) => ({ id: c.id, in: c.in_tokens, out: c.out_tokens, status: c.status })), bad: r.bad.map((x) => ({ id: x.claim.id, reason: x.reason })) });
    if (a.dispute) for (const x of r.bad) console.log("disputed", x.claim.id, (await b.dispute(x.claim.id, x.reason)).txHash);
  },

  async close() {
    const { Buyer } = await import("./buyer.js");
    const cfg = await view("get_config");
    out(`order closing; refund after the ${cfg.challenge_window_sec} s claim window (credster settle, or a keeper does it): ${tx(await new Buyer(need("buyer")).close(need("order")))}`);
  },

  async settle() {
    const r = await call(need("signer"), "settle_close", { order_id: String(need("order")) });
    const o = await view("get_order", { order_id: String(need("order")) });
    out(`order ${o.id} closed: spent ${fmtNear(o.spent, 6)}, refunded ${fmtNear(BigInt(o.deposit) - BigInt(o.spent), 6)} NEAR  ${tx(r)}`);
  },

  /** Keyless check: every local grade report hashes to the report_hash on chain. */
  async "verify-reports"() {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { sha256hex } = await import("./sign.js");
    const { REPORTS } = await import("./grader.js");
    let bad = 0;
    for (const l of await viewAll("get_listings")) {
      if (!l.grade) continue;
      const name = l.grade.report_url.split("/").pop();
      const file = join(REPORTS, name);
      let text = existsSync(file) ? readFileSync(file, "utf8") : null;
      if (text === null && /^https?:\/\//.test(l.grade.report_url)) text = await fetch(l.grade.report_url).then((r) => (r.ok ? r.text() : null)).catch(() => null);
      if (text === null) { console.log(`#${l.id} ${l.grade.tier}: report not in this checkout or at ${l.grade.report_url}`); continue; }
      const ok = sha256hex(text) === l.grade.report_hash;
      const r = JSON.parse(text);
      if (!ok) bad++;
      console.log(`#${l.id} ${l.model} grade ${l.grade.tier}: report hash ${ok ? "matches chain" : "MISMATCH"}; fingerprint ${r.fingerprint.verdict}, TEE ${r.attestation.verdict}${r.decision.reasons.length ? "; " + r.decision.reasons.join("; ") : ""}`);
    }
    if (bad) process.exit(1);
  },

  async finalize() {
    const claims = await viewAll("get_claims");
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
  if (cmd && cmd !== "--help") console.error(`unknown command ${cmd}\n`);
  await commands.help();
  process.exit(cmd ? 2 : 0);
}
commands[cmd]().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

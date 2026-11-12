#!/usr/bin/env node
// Prepares a live market that visitors can trade on, then `credster live` serves it.
//
//   node scripts/go-live.mjs --public-url https://credster.example.com          # reuse P / TS_CONTRACT
//   node scripts/go-live.mjs --public-url https://credster.example.com --fresh  # new testnet deployment
//
// Reuse: needs the keys of the parent account P, its grader and the six demo
// sellers (s-honest.P, ...) in the keychain (TS_CREDENTIALS or ~/.near-credentials).
// Each seller's latest listing gets a new node key and the public endpoint;
// the contract clears its grade and the live server's keeper grades it again.
//
// Fresh: creates a faucet-funded parent, the market (code from --wasm, from
// contract/target, or copied from the reference deployment), a grader and six
// sellers, then lists the six personas. No Rust or near CLI needed.
//
// Both write $CREDSTER_HOME/live.json (the hosted nodes) and $CREDSTER_HOME/live.env.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (!k.startsWith("--")) continue;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) args[k.slice(2)] = true;
  else { args[k.slice(2)] = v; i++; }
}
if (args.help || !args["public-url"]) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 18).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(args.help ? 0 : 2);
}
const PUBLIC = String(args["public-url"]).replace(/\/$/, "");
if (!/^https?:\/\//.test(PUBLIC)) throw new Error("--public-url must start with https:// (or http:// for a local test)");

const near_ = await import("../node/src/near.js");
const { view, viewAll, near, fmtNear, hasKey, saveKey, balance, transfer, createSubAccount, deleteAccount, deployContract, setContract, viewCode, viewAccount, newKeyPair, NETWORK } = near_;
const { createListing, moveListing } = await import("../node/src/seller-node.js");
const { PERSONAS } = await import("../node/src/personas.js");
const { path, readJson, writeJson, HOME } = await import("../node/src/store.js");
if (NETWORK !== "testnet") throw new Error("go-live only runs on testnet");

const personas = String(args.personas || "honest,swap,sibling,inflate,deepseek,overclaim").split(",");
for (const p of personas) if (!PERSONAS[p]) throw new Error(`unknown persona ${p}`);
const HELPER = process.env.TS_HELPER_URL || "https://helper.nearprotocol.com/account";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log(...a);

/** A new top-level .testnet account funded by the public testnet faucet service. */
async function faucetAccount(prefix) {
  const id = `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.testnet`;
  const kp = newKeyPair();
  saveKey(id, kp);
  const r = await fetch(HELPER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }) });
  if (!r.ok) throw new Error(`testnet faucet ${r.status}: ${(await r.text()).slice(0, 200)}`);
  for (let i = 0; i < 20 && (await balance(id)) === null; i++) await sleep(1500);
  if ((await balance(id)) === null) throw new Error(`faucet account ${id} did not appear`);
  return id;
}

async function ensureBalance(id, min, from) {
  const have = await balance(id);
  if (have !== null && have >= min) return;
  const need = min - (have || 0n);
  say(`  top up ${id} with ${fmtNear(need, 3)} NEAR from ${from}`);
  await transfer(from, id, need);
}

let P = process.env.P || (process.env.TS_CONTRACT || "").replace(/^market\./, "");
const hosted = {};

if (args.fresh && (!P || !hasKey(P))) {
  P = await faucetAccount("credster-live");
  say(`  parent ${P} (10 NEAR from the testnet faucet)`);
}
// --top-up N: N more faucet accounts, each deleted into the parent (about 10 NEAR each),
// for the visitor faucet and launched sellers.
for (let i = 0; i < Number(args["top-up"] || 0); i++) {
  const extra = await faucetAccount("credster-topup");
  await deleteAccount(extra, P);
  near_.forgetKey(extra);
  say(`  topped up ${P} from ${extra}`);
}

if (args.fresh) {
  say(`# Fresh deployment on testnet`);
  const market = `market.${P}`;
  const grader = `grader.${P}`;
  const subs = [[market, "3.5"], [grader, "1.5"], ...personas.map((p) => [`s-${p}.${P}`, "0.35"])];
  for (const [id, amt] of subs) {
    if ((await balance(id)) !== null) { say(`  ${id} exists`); continue; }
    const r = await createSubAccount(P, id, near(amt));
    say(`  created ${id} with ${amt} NEAR tx ${r.txHash}`);
  }
  let code;
  const local = join(HERE, "..", "contract", "target", "near", "credster_market.wasm");
  if (args.wasm) code = readFileSync(args.wasm);
  else if (existsSync(local)) code = readFileSync(local);
  else {
    const ref = process.env.TS_REFERENCE_CONTRACT || "market.credster-68480.testnet";
    const c = await viewCode(ref);
    code = Buffer.from(c.code_base64, "base64");
    say(`  contract code copied from ${ref} (code hash ${c.hash}); build your own with: cd contract && cargo near build`);
  }
  const deployed = await viewCode(market).then(() => true, () => false);
  if (!deployed) {
    const r = await deployContract(market, code, {
      method: "new",
      args: { grader, min_bond: near("0.2").toString(), min_deposit: near("0.01").toString(), challenge_window_sec: 60, max_grade_age_sec: 86400, trial_cap: near("0.05").toString() },
    });
    say(`  deployed and initialized ${market} tx ${r.txHash}`);
  } else say(`  ${market} already has a contract`);
  setContract(market);
  for (const p of personas) {
    const s = PERSONAS[p];
    const conf = readJson(path("nodes", p, "node.json"));
    if (conf?.listing_id !== undefined && conf.seller === `s-${p}.${P}`) { say(`  ${p}: listing ${conf.listing_id} exists`); hosted[p] = { name: p, persona: p, kind: "demo" }; continue; }
    const r = await createListing({ name: p, seller: `s-${p}.${P}`, model: s.model, endpoint: `${PUBLIC}/s/${p}/v1`, askIn: near(s.ask[0]), askOut: near(s.ask[1]), capacity: "5000000", bond: near("0.2") });
    say(`  ${p}: listing ${r.listingId} for ${s.model} tx ${r.txHash}`);
    hosted[p] = { name: p, persona: p, kind: "demo" };
  }
} else {
  const contract = process.env.TS_CONTRACT || (P ? `market.${P}` : "");
  if (!contract) throw new Error("set P (parent account) or TS_CONTRACT, or pass --fresh");
  setContract(contract);
  P ||= contract.replace(/^market\./, "");
  say(`# Reusing ${contract}`);
  const cfg = await view("get_config");
  const missing = [P, cfg.grader, ...personas.map((p) => `s-${p}.${P}`)].filter((id) => !hasKey(id));
  if (missing.length) throw new Error(`no keys in the keychain for: ${missing.join(", ")}. Copy them from the machine that ran setup-testnet.sh, or use --fresh.`);
  const listings = await viewAll("get_listings");
  for (const p of personas) {
    const seller = `s-${p}.${P}`;
    const mine = listings.filter((l) => l.seller === seller && l.status !== "Closed").sort((a, b) => Number(b.id) - Number(a.id));
    const s = PERSONAS[p];
    const file = path("nodes", p, "node.json");
    // Gas for claims and moves; a new listing also needs its 0.2 NEAR bond.
    await ensureBalance(seller, near(mine.length ? "0.1" : "0.3"), P);
    if (!mine.length) {
      const r = await createListing({ name: p, seller, model: s.model, endpoint: `${PUBLIC}/s/${p}/v1`, askIn: near(s.ask[0]), askOut: near(s.ask[1]), capacity: "5000000", bond: near("0.2") });
      say(`  ${p}: new listing ${r.listingId} tx ${r.txHash}`);
    } else {
      const l = mine[0];
      let conf = readJson(file);
      if (!conf || String(conf.listing_id) !== String(l.id)) {
        // The node key from the recorded run lived in a throwaway directory, so
        // the node gets a new one; update_endpoint registers it on chain.
        const kp = newKeyPair();
        conf = { name: p, seller, node_key: kp.getPublicKey().toString(), node_secret: kp.toString(), listing_id: String(l.id), model: l.model, endpoint: l.endpoint };
        writeJson(file, conf);
      }
      if (l.endpoint !== `${PUBLIC}/s/${p}/v1` || l.node_key !== conf.node_key) {
        const r = await moveListing(p, `${PUBLIC}/s/${p}/v1`);
        say(`  ${p}: listing ${l.id} moved to ${PUBLIC}/s/${p}/v1 (grade cleared until the keeper grades it) tx ${r.txHash}`);
      } else say(`  ${p}: listing ${l.id} already points here`);
    }
    hosted[p] = { name: p, persona: p, kind: "demo" };
  }
  await ensureBalance(cfg.grader, near("0.8"), P);
}

// Storage for many visitors' orders is paid by the market account.
const market = process.env.TS_CONTRACT || `market.${P}`;
const acct = await viewAccount(market);
const free = BigInt(acct.amount) - BigInt(acct.storage_usage) * 10n ** 19n;
if (free < near("1")) await ensureBalance(market, BigInt(acct.amount) + near("1.5") - free, P);

const state = readJson(path("live.json"), { hosted: {} });
for (const [k, v] of Object.entries(hosted)) state.hosted[k] = { ...state.hosted[k], ...v };
writeJson(path("live.json"), state);
const envLines = [
  `TS_NETWORK=testnet`,
  `TS_CONTRACT=${market}`,
  `TS_PUBLIC_URL=${PUBLIC}`,
  `TS_PARENT=${P}`,
  `CREDSTER_HOME=${HOME}`,
  `TS_CREDENTIALS=${near_.CRED_DIR}`,
];
writeFileSync(join(HOME, "live.env"), envLines.join("\n") + "\n", { mode: 0o600 });
say(`\nparent ${P} has ${fmtNear((await balance(P)) || 0n, 3)} NEAR for the faucet and launched sellers`);
say(`wrote ${join(HOME, "live.env")} and ${path("live.json")}`);
say(`\nstart the server:\n  set -a; . ${join(HOME, "live.env")}; set +a\n  export TS_UPSTREAM_KEY=<your NEAR AI Cloud key>\n  node node/src/cli.js live`);
say(`\nor in Docker (copy ${HOME} to <data>/credster and ${near_.CRED_DIR} to <data>/near-credentials first):\n  docker build -t credster . && docker run -p 8080:8080 -v <data>:/data -e TS_CONTRACT=${market} -e TS_PUBLIC_URL=${PUBLIC} -e TS_PARENT=${P} -e TS_UPSTREAM_KEY=... credster`);
process.exit(0);

// Live market server: everything a visitor needs to trade on testnet, behind one URL.
//
// - serves the website (web/) and the grade reports
// - hosts seller nodes under /s/<name>/ (the demo personas, honest and cheating)
// - runs the keeper: grading, settlement, refunds, disputes, seller agents
// - POST /api/faucet: a little test NEAR for a throwaway browser account
// - POST /api/sellers: launches a new seller (account, bond, listing, node)
//
// Configuration is environment variables; see JUDGING.md and `credster live --help`.
import http from "node:http";
import { createReadStream, existsSync, statSync, rmSync } from "node:fs";
import { join, extname, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import {
  NETWORK, RPC, RPCS, CONTRACT, requireContract, view, call, near, fmtNear, hasKey, balance, transfer,
  createSubAccount, deleteAccount, forgetKey,
} from "./near.js";
import { createSellerNode, createListing, moveListing } from "./seller-node.js";
import { createKeeper } from "./keeper.js";
import { PERSONAS, LAUNCHABLE } from "./personas.js";
import { path, readJson, writeJson, HOME } from "./store.js";
import { REPORTS } from "./grader.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== "" ? Number(env[k]) : d);

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8", ".ico": "image/x-icon",
};
const API_CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };
const ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** Sliding-window counter per key: allow(key) is true at most `max` times per `windowMs`. */
function limiter(max, windowMs) {
  const hits = new Map();
  return {
    allow(key) {
      const now = Date.now();
      const xs = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (xs.length >= max) { hits.set(key, xs); return false; }
      xs.push(now);
      hits.set(key, xs);
      return true;
    },
    retryAfterSec(key) {
      const xs = hits.get(key) || [];
      return xs.length ? Math.ceil((windowMs - (Date.now() - xs[0])) / 1000) : 0;
    },
  };
}

export async function startLive() {
  requireContract();
  const PUBLIC = (env.TS_PUBLIC_URL || "").replace(/\/$/, "");
  if (!/^https?:\/\//.test(PUBLIC)) throw new Error("set TS_PUBLIC_URL to the address visitors and the grader reach this server at, e.g. https://credster.example.com");
  const PORT = num("PORT", 8080);
  const HOST = env.HOST || "0.0.0.0";
  const WEB = resolve(env.TS_WEB_ROOT || join(HERE, "..", "..", "web"));
  const cfg = await view("get_config");
  const GRADER = env.TS_GRADER || cfg.grader;
  const PARENT = env.TS_PARENT || (CONTRACT.startsWith("market.") ? CONTRACT.slice("market.".length) : "");
  const FAUCET = env.TS_FAUCET || PARENT;
  const testnet = NETWORK === "testnet";
  const faucetOn = testnet && env.TS_FAUCET_OFF !== "1" && !!FAUCET && hasKey(FAUCET);
  const launchOn = testnet && env.TS_LAUNCH_OFF !== "1" && !!PARENT && hasKey(PARENT) && !!env.TS_UPSTREAM_KEY;
  const L = {
    faucetAmount: near(env.TS_FAUCET_AMOUNT || "0.1"),
    faucetReserve: near(env.TS_FAUCET_RESERVE || "1"),
    faucetPerIpHour: num("TS_FAUCET_PER_IP_HOUR", 3),
    faucetPerDay: num("TS_FAUCET_PER_DAY", 200),
    launchPerIpHour: num("TS_LAUNCH_PER_IP_HOUR", 3),
    launchMax: num("TS_LAUNCH_MAX", 8),
    launchTtlMin: num("TS_LAUNCH_TTL_MIN", 120),
    maxTokens: num("TS_NODE_MAX_TOKENS", 1024),
    callsPerOrder: num("TS_NODE_CALLS_PER_ORDER", 30),
    callsPerDay: num("TS_NODE_CALLS_PER_DAY", 3000),
    claimEverySec: num("TS_NODE_CLAIM_EVERY", 12),
  };
  if (!hasKey(GRADER)) throw new Error(`no key for the grader ${GRADER} in the keychain; the live server grades listings and resolves disputes as the grader`);

  const lines = [];
  const log = (...a) => {
    const line = `${new Date().toISOString().slice(11, 19)} ${a.join(" ")}`;
    console.log(line);
    lines.push(line);
    if (lines.length > 500) lines.shift();
  };

  // ---------------------------------------------------------------- nodes
  const stateFile = path("live.json");
  const state = readJson(stateFile, { hosted: {} });
  const save = () => writeJson(stateFile, state);
  const nodes = new Map(); // name -> node
  const sellers = new Map(); // listing id -> seller account of a hosted node
  let callsToday = { day: "", n: 0 };
  const allowCall = () => {
    const d = new Date().toISOString().slice(0, 10);
    if (callsToday.day !== d) callsToday = { day: d, n: 0 };
    if (callsToday.n >= L.callsPerDay) return false;
    callsToday.n++;
    return true;
  };
  const endpointOf = (name) => `${PUBLIC}/s/${name}/v1`;

  function mount(name) {
    const h = state.hosted[name];
    const p = PERSONAS[h.persona];
    const node = createSellerNode({
      name, upstreamKey: env.TS_UPSTREAM_KEY, mode: p.mode, swapModel: p.swapModel, inflate: p.inflate ?? 1.35,
      claimEverySec: L.claimEverySec, maxTokens: L.maxTokens, maxCallsPerOrder: L.callsPerOrder, allowCall, log,
    });
    nodes.set(name, node);
    sellers.set(String(node.listingId), node.seller);
    return node;
  }

  function unmount(name) {
    const n = nodes.get(name);
    if (!n) return;
    n.close();
    nodes.delete(name);
    sellers.delete(String(n.listingId));
  }

  // Bring every hosted listing to this server's public URL. Moving a listing
  // clears its grade on chain, so the keeper grades it again.
  for (const name of Object.keys(state.hosted)) {
    const conf = readJson(path("nodes", name, "node.json"));
    const l = conf?.listing_id !== undefined ? await view("get_listing", { listing_id: String(conf.listing_id) }) : null;
    if (!l || l.status === "Closed") { log(`hosted ${name}: listing gone or closed, dropped`); delete state.hosted[name]; continue; }
    if (!env.TS_UPSTREAM_KEY) throw new Error("hosted seller nodes need TS_UPSTREAM_KEY (the seller's NEAR AI Cloud key)");
    if (l.endpoint !== endpointOf(name) || l.node_key !== conf.node_key) {
      const r = await moveListing(name, endpointOf(name));
      log(`hosted ${name}: listing ${l.id} moved to ${endpointOf(name)} tx ${r.txHash}`);
    }
    mount(name);
  }
  save();

  const keeper = createKeeper({
    grader: GRADER, signer: env.TS_KEEPER_SIGNER || GRADER, log,
    sellerFor: (l) => sellers.get(String(l.id)) || null,
  }).start();

  // ---------------------------------------------------------------- launches
  const launchesByIp = limiter(L.launchPerIpHour, 3600_000);
  const launching = new Set();

  async function launch(persona, ip) {
    const p = PERSONAS[persona];
    const tag = randomBytes(2).toString("hex");
    const name = `j-${persona}-${tag}`;
    const seller = `${name}.${PARENT}`;
    launching.add(name);
    try {
      // 0.2 bond, storage, and the gas NEAR reserves up front on each call.
      // Retiring deletes the account into the parent, so what is left comes back.
      const acct = await createSubAccount(PARENT, seller, near("0.3"));
      log(`launch ${name}: account ${seller} tx ${acct.txHash}`);
      let listing;
      try {
        listing = await createListing({ name, seller, model: p.model, endpoint: endpointOf(name), askIn: near(p.ask[0]), askOut: near(p.ask[1]), capacity: "500000", bond: near("0.2") });
      } catch (e) {
        await deleteAccount(seller, PARENT).catch(() => {});
        throw e;
      }
      state.hosted[name] = { name, persona, kind: "launch", created_at: Date.now(), expires_at: Date.now() + L.launchTtlMin * 60_000, by: createHash("sha256").update(String(ip)).digest("hex").slice(0, 12) };
      save();
      mount(name);
      keeper.gradeSoon(listing.listingId);
      keeper.emit("launch", `a visitor launched a "${p.title}" seller: listing ${listing.listingId} (${p.model}); the grader probes it next`, { listing: String(listing.listingId), tx: listing.txHash, persona });
      return { name, persona, seller, listing_id: String(listing.listingId), endpoint: endpointOf(name), txs: { account: acct.txHash, listing: listing.txHash }, expires_at: state.hosted[name].expires_at };
    } finally {
      launching.delete(name);
    }
  }

  // Launched sellers retire after their TTL: pause, wait for open orders, close
  // the listing (the bond comes back) and delete the account into the parent.
  async function retireTick() {
    for (const h of Object.values(state.hosted).filter((x) => x.kind === "launch" && x.expires_at < Date.now())) {
      const conf = readJson(path("nodes", h.name, "node.json"));
      try {
        const l = await view("get_listing", { listing_id: String(conf.listing_id) });
        if (l && l.status !== "Closed") {
          if (l.open_orders > 0 || l.open_offers > 0) {
            if (l.status === "Active") await call(conf.seller, "set_paused", { listing_id: String(l.id), paused: true });
            continue;
          }
          await call(conf.seller, "close_listing", { listing_id: String(l.id) });
        }
        unmount(h.name);
        const r = await deleteAccount(conf.seller, PARENT);
        forgetKey(conf.seller);
        delete state.hosted[h.name];
        save();
        rmSync(path("nodes", h.name), { recursive: true, force: true });
        keeper.emit("retire", `launched seller ${h.name} retired: listing ${conf.listing_id} closed, its bond went back to the faucet`, { listing: String(conf.listing_id), tx: r.txHash });
      } catch (e) {
        log(`retire ${h.name}: ${e.message.slice(0, 160)}`);
      }
    }
  }
  setInterval(retireTick, 60_000).unref();

  // ---------------------------------------------------------------- faucet
  const dripsByIp = limiter(L.faucetPerIpHour, 3600_000);
  const dripsByAccount = limiter(1, 6 * 3600_000);
  let dripsToday = { day: "", n: 0 };

  async function drip(accountId, ip) {
    const d = new Date().toISOString().slice(0, 10);
    if (dripsToday.day !== d) dripsToday = { day: d, n: 0 };
    if (dripsToday.n >= L.faucetPerDay) throw Object.assign(new Error("the faucet reached today's limit; try tomorrow or use https://near-faucet.io"), { status: 429 });
    const have = await balance(accountId);
    if (have !== null && have >= near("0.5")) throw Object.assign(new Error("this account already has enough test NEAR"), { status: 400 });
    if (!dripsByAccount.allow(accountId)) throw Object.assign(new Error("this account got test NEAR recently"), { status: 429 });
    if (!dripsByIp.allow(ip)) throw Object.assign(new Error(`too many requests from your network; try again in ${Math.ceil(dripsByIp.retryAfterSec(ip) / 60)} min`), { status: 429 });
    const fb = await balance(FAUCET);
    if (fb === null || fb < L.faucetReserve + L.faucetAmount) throw Object.assign(new Error("the faucet is empty; tell the operator"), { status: 503 });
    dripsToday.n++;
    const r = await transfer(FAUCET, accountId, L.faucetAmount);
    keeper.emit("faucet", `faucet sent ${fmtNear(L.faucetAmount, 2)} test NEAR to ${accountId.length > 20 ? accountId.slice(0, 8) + "…" + accountId.slice(-6) : accountId}`, { tx: r.txHash });
    return { account_id: accountId, amount: L.faucetAmount.toString(), tx: r.txHash };
  }

  // ---------------------------------------------------------------- http
  const clientIp = (req) =>
    (env.TRUST_PROXY === "1" && (req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim())) || req.socket.remoteAddress || "?";

  function json(res, status, obj, extra = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...API_CORS, ...extra });
    res.end(body);
  }

  async function readJsonBody(req, max = 4096) {
    let n = 0;
    const chunks = [];
    for await (const c of req) {
      n += c.length;
      if (n > max) throw Object.assign(new Error("body too large"), { status: 413 });
      chunks.push(c);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { throw Object.assign(new Error("body must be JSON"), { status: 400 }); }
  }

  function serveFile(req, res, file, cache) {
    const st = statSync(file);
    const type = MIME[extname(file).toLowerCase()] || "application/octet-stream";
    const headers = { "content-type": type, "accept-ranges": "bytes", "cache-control": cache, "x-content-type-options": "nosniff" };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range) {
      let start = range[1] === "" ? st.size - Number(range[2]) : Number(range[1]);
      let end = range[1] === "" || range[2] === "" ? st.size - 1 : Number(range[2]);
      if (start < 0 || start >= st.size || end < start) {
        res.writeHead(416, { "content-range": `bytes */${st.size}` });
        return res.end();
      }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
      if (req.method === "HEAD") return res.end();
      return createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "content-length": st.size });
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
  }

  function staticFile(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return json(res, 400, { error: "bad path" }); }
    if (rel.includes("\0")) return json(res, 400, { error: "bad path" });
    let file = resolve(WEB, "." + rel);
    if (file !== WEB && !file.startsWith(WEB + sep)) return json(res, 403, { error: "forbidden" });
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    const ext = extname(file);
    const cache = ext === ".html" ? "no-cache" : /\/site\/(media|fonts|vendor)\//.test(file) ? "public, max-age=86400" : "public, max-age=300";
    serveFile(req, res, file, cache);
  }

  function report(req, res, name) {
    if (!/^listing-\d+-\d+\.json$/.test(name)) return json(res, 404, { error: "no such report" });
    for (const dir of [REPORTS, join(WEB, "reports")]) {
      const f = join(dir, name);
      if (existsSync(f)) {
        res.setHeader("access-control-allow-origin", "*");
        return serveFile(req, res, f, "public, max-age=3600");
      }
    }
    json(res, 404, { error: "no such report" });
  }

  function status() {
    return {
      network: NETWORK, rpc: RPC, rpcs: RPCS, contract: CONTRACT, public_url: PUBLIC, grader: GRADER,
      challenge_window_sec: cfg.challenge_window_sec, max_grade_age_sec: cfg.max_grade_age_sec,
      faucet: { enabled: faucetOn, amount: L.faucetAmount.toString() },
      launch: {
        enabled: launchOn, ttl_min: L.launchTtlMin, max: L.launchMax,
        active: Object.values(state.hosted).filter((h) => h.kind === "launch").length + launching.size,
        personas: Object.fromEntries(LAUNCHABLE.map((k) => [k, { title: PERSONAS[k].title, blurb: PERSONAS[k].blurb, expect: PERSONAS[k].expect, model: PERSONAS[k].model }])),
      },
      limits: { max_tokens: L.maxTokens, calls_per_order: L.callsPerOrder },
      hosted: [...nodes.values()].map((n) => {
        const h = state.hosted[n.name];
        const p = PERSONAS[h.persona];
        return { name: n.name, persona: h.persona, title: p.title, blurb: p.blurb, kind: h.kind, listing_id: String(n.listingId), seller: n.seller, model: p.model, endpoint: endpointOf(n.name), expires_at: h.expires_at || null };
      }),
      keeper: keeper.status(),
    };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    try {
      const m = p.match(/^\/s\/([a-z0-9-]{1,48})(\/.*)$/);
      if (m) {
        const node = nodes.get(m[1]);
        if (!node) return json(res, 404, { error: { message: "no such seller node on this server", type: "credster" } });
        const sub = new URL(m[2] + url.search, "http://x");
        return await node.handle(req, res, sub);
      }
      if (p.startsWith("/api/")) {
        if (req.method === "OPTIONS") { res.writeHead(204, API_CORS); return res.end(); }
        if (req.method === "GET" && p === "/api/status") return json(res, 200, status());
        if (req.method === "GET" && p === "/api/log" && env.TS_PUBLIC_LOG === "1") return json(res, 200, { lines: lines.slice(-200) });
        if (req.method === "POST" && p === "/api/faucet") {
          if (!faucetOn) return json(res, 503, { error: "the faucet is off on this server" });
          const body = await readJsonBody(req);
          const id = String(body.account_id || "").trim();
          const ok = ACCOUNT_RE.test(id) && (/^[0-9a-f]{64}$/.test(id) || id.endsWith(".testnet"));
          if (!ok) return json(res, 400, { error: "account_id must be a 64-character implicit account or a .testnet account" });
          return json(res, 200, await drip(id, clientIp(req)));
        }
        if (req.method === "POST" && p === "/api/sellers") {
          if (!launchOn) return json(res, 503, { error: "launching sellers is off on this server" });
          const body = await readJsonBody(req);
          const persona = String(body.persona || "");
          if (!LAUNCHABLE.includes(persona)) return json(res, 400, { error: `persona must be one of ${LAUNCHABLE.join(", ")}` });
          const active = Object.values(state.hosted).filter((h) => h.kind === "launch").length + launching.size;
          if (active >= L.launchMax) return json(res, 429, { error: `${active} launched sellers are running, the most this server allows. Each retires after ${L.launchTtlMin} min.` });
          const ip = clientIp(req);
          if (!launchesByIp.allow(ip)) return json(res, 429, { error: `you launched ${L.launchPerIpHour} sellers this hour; try again in ${Math.ceil(launchesByIp.retryAfterSec(ip) / 60)} min` });
          return json(res, 200, await launch(persona, ip));
        }
        return json(res, 404, { error: "no such endpoint" });
      }
      const rm = p.match(/^\/reports\/([^/]+)$/);
      if (rm && (req.method === "GET" || req.method === "HEAD")) return report(req, res, rm[1]);
      if (p === "/health") return json(res, 200, { ok: true, nodes: nodes.size, last_settle_at: keeper.status().last_settle_at });
      if (req.method === "GET" || req.method === "HEAD") return staticFile(req, res, p);
      json(res, 405, { error: "method not allowed" });
    } catch (e) {
      log(`http ${req.method} ${p}: ${e.message.slice(0, 200)}`);
      if (!res.headersSent) json(res, e.status || 500, { error: e.message.slice(0, 300) });
    }
  });
  server.requestTimeout = 180_000;
  await new Promise((r) => server.listen(PORT, HOST, r));
  log(`credster live on ${HOST}:${PORT}, public ${PUBLIC}`);
  log(`  contract ${CONTRACT} (${NETWORK}, ${RPC}), grader ${GRADER}, ${nodes.size} hosted node(s): ${[...nodes.keys()].join(", ") || "none"}`);
  log(`  faucet ${faucetOn ? `on (${FAUCET}, ${fmtNear(L.faucetAmount, 2)} NEAR per account)` : "off"}; launches ${launchOn ? `on (parent ${PARENT}, ${L.launchTtlMin} min each)` : "off"}; state ${HOME}`);
  return { server, keeper, nodes };
}

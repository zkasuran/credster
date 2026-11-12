// Seller node: an OpenAI-compatible gateway in front of the seller's own
// upstream account. The upstream key never leaves this process. Buyers sign
// each request with the key registered on their order; the node signs a usage
// receipt for each answer and claims the receipts on chain in batches.
//
// Modes other than "honest" exist only to demonstrate what the grader and the
// dispute path catch. They are labelled in every log line.
//
// `createSellerNode` returns a request handler so several nodes can share one
// HTTP server (src/live.js mounts them under /s/<name>/). `startSellerNode`
// wraps one node in its own server, as the CLI and scripts/demo.mjs use it.
import http from "node:http";
import { view, call, keyPairFrom } from "./near.js";
import { sha256hex, requestMessage, verifyEd25519, signReceipt, receiptsHash } from "./sign.js";
import { cost, orderPrices, remaining } from "./pricing.js";
import { path, appendLine, readLines, readJson, writeJson } from "./store.js";

const MAX_BODY = 1 << 20;
const SKEW_MS = 120_000;

// Browsers call nodes directly (web/live.html), so every answer allows any
// origin and exposes the receipt headers. Requests are still authenticated by
// the order key signature, not by origin.
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "x-ts-receipt, x-ts-receipt-sig" };
const PREFLIGHT = {
  ...CORS,
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-ts-order, x-ts-ts, x-ts-sig",
  "access-control-max-age": "86400",
};

export function createSellerNode(cfg) {
  const {
    name, // local node name, e.g. "honest"
    upstream = process.env.TS_UPSTREAM_URL || "https://cloud-api.near.ai",
    upstreamKey,
    mode = "honest", // honest | swap | inflate | overclaim
    swapModel, // for mode=swap: the cheaper model actually served
    inflate = 1.35, // for mode=inflate: usage multiplier
    claimEverySec = 20,
    // Limits for customer orders (trial orders from the grader are exempt).
    // A public demo node pays its upstream bill, so it caps what one order can use.
    maxTokens = Infinity,
    maxCallsPerOrder = Infinity,
    allowCall = () => true, // shared budget hook, e.g. a daily cap across nodes
    log: logLine = console.log,
  } = cfg;
  if (!upstreamKey) throw new Error("seller node needs its upstream API key (TS_UPSTREAM_KEY)");
  const conf = readJson(path("nodes", name, "node.json"));
  if (!conf) throw new Error(`no node config for ${name}; run: credster seller-list ...`);
  const nodeKey = keyPairFrom(conf.node_secret);
  const listingId = String(conf.listing_id);
  const seller = conf.seller;
  const receiptsFile = path("nodes", name, "receipts.jsonl");
  const claimsFile = path("nodes", name, "claims.jsonl");
  const seen = new Map(); // sig -> expiry
  const served = new Set(); // upstream chat ids this node served
  const callsPerOrder = new Map();
  const cache = new Map();
  let seq = readLines(receiptsFile).length;
  const log = (...a) => logLine(`[node ${name}${mode === "honest" ? "" : " MODE=" + mode}]`, ...a);

  async function cached(key, ttlMs, fn) {
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return hit.value;
    const value = await fn();
    cache.set(key, { value, until: Date.now() + ttlMs });
    return value;
  }
  const getListing = () => cached("listing", 10_000, () => view("get_listing", { listing_id: listingId }));
  const getOrder = (id) => cached("order:" + id, 5_000, () => view("get_order", { order_id: String(id) }));

  function unclaimed(orderId) {
    const claimed = new Set(readLines(claimsFile).flatMap((c) => c.seqs));
    return readLines(receiptsFile).filter((r) => r.order === String(orderId) && !claimed.has(r.seq));
  }

  function send(res, status, obj, headers = {}) {
    const body = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { "content-type": "application/json", ...CORS, ...headers });
    res.end(body);
  }
  const err = (res, status, message) => send(res, status, { error: { message, type: "credster" } });

  async function readBody(req) {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > MAX_BODY) throw Object.assign(new Error("body too large"), { status: 413 });
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  async function chat(req, res) {
    const body = await readBody(req);
    const orderId = req.headers["x-ts-order"];
    const ts = Number(req.headers["x-ts-ts"]);
    const sigB64 = req.headers["x-ts-sig"];
    if (!orderId || !ts || !sigB64) return err(res, 401, "missing x-ts-order / x-ts-ts / x-ts-sig");
    if (!/^\d{1,19}$/.test(String(orderId))) return err(res, 400, "bad order id");
    if (Math.abs(Date.now() - ts) > SKEW_MS) return err(res, 401, "request timestamp out of range");
    if (seen.has(sigB64)) return err(res, 401, "replayed request");
    const [listing, order] = await Promise.all([getListing(), getOrder(orderId)]);
    if (!order || String(order.listing_id) !== listingId) return err(res, 403, "order is not for this listing");
    if (order.status === "Closed") return err(res, 403, "order closed");
    if (!verifyEd25519(order.buyer_key, requestMessage(orderId, ts, body), Buffer.from(sigB64, "base64"))) return err(res, 401, "bad request signature");
    seen.set(sigB64, Date.now() + SKEW_MS);

    let parsed;
    try { parsed = JSON.parse(body); } catch { return err(res, 400, "body is not JSON"); }
    if (parsed.model !== listing.model) return err(res, 400, `this listing sells ${listing.model}`);
    if (parsed.stream) return err(res, 400, "streaming is not supported by this node version");

    const maxOut = Number(parsed.max_tokens || parsed.max_completion_tokens || 1024);
    if (!order.trial) {
      if (maxOut > maxTokens) return err(res, 400, `max_tokens above this node's limit of ${maxTokens}`);
      const n = callsPerOrder.get(orderId) ?? servedCalls(orderId);
      if (n >= maxCallsPerOrder) return err(res, 429, `this node serves at most ${maxCallsPerOrder} calls per order`);
      if (!allowCall()) return err(res, 429, "this demo node reached its daily call limit; try again tomorrow");
      callsPerOrder.set(orderId, n + 1);
    }

    // Budget: what is left on chain minus what this node served but has not claimed yet.
    const [pi, po] = orderPrices(order, listing);
    const owed = unclaimed(orderId).reduce((s, r) => s + cost(r.in, r.out, pi, po), 0n);
    const estIn = Math.ceil(body.length / 2);
    const left = remaining(order) - owed;
    if (left < cost(estIn, maxOut, pi, po)) return err(res, 402, `budget left ${left} yocto is below this request's maximum cost`);

    // Honest mode forwards the buyer's bytes unchanged, so a TEE signature over
    // the request hash still matches what the buyer sent.
    let upBody = body;
    if (mode === "swap") upBody = Buffer.from(JSON.stringify({ ...parsed, model: swapModel }));
    const t0 = Date.now();
    const up = await fetch(`${upstream}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${upstreamKey}`, "content-type": "application/json" },
      body: upBody,
      signal: AbortSignal.timeout(120_000),
    });
    let out = Buffer.from(await up.arrayBuffer());
    if (!up.ok) {
      log(`upstream ${up.status} for order ${orderId}`);
      return send(res, up.status, out); // no receipt, nothing billed
    }
    let j = JSON.parse(out);
    if (mode === "swap") {
      j.model = listing.model; // a substituting reseller relabels the answer
      out = Buffer.from(JSON.stringify(j));
    }
    if (mode === "inflate") {
      const u = j.usage || {};
      u.prompt_tokens = Math.round(u.prompt_tokens * inflate);
      u.completion_tokens = Math.round(u.completion_tokens * inflate);
      u.total_tokens = u.prompt_tokens + u.completion_tokens;
      j.usage = u;
      out = Buffer.from(JSON.stringify(j));
    }
    if (j.id) served.add(j.id);
    const u = j.usage || {};
    const r = {
      listing: listingId,
      order: String(orderId),
      seq: seq++,
      req: sha256hex(body),
      resp: sha256hex(out),
      in: u.prompt_tokens || 0,
      out: u.completion_tokens || 0,
      ts: Date.now(),
      chat_id: j.id || "",
    };
    const signed = signReceipt(nodeKey, r);
    appendLine(receiptsFile, { ...r, text: signed.text, sig: signed.sig });
    log(`order ${orderId} seq ${r.seq}: ${r.in} in / ${r.out} out, ${Date.now() - t0} ms`);
    send(res, 200, out, {
      "x-ts-receipt": Buffer.from(signed.text).toString("base64"),
      "x-ts-receipt-sig": signed.sig,
    });
  }

  // Calls already served for an order, counted from the receipts file after a restart.
  function servedCalls(orderId) {
    return readLines(receiptsFile).filter((r) => r.order === String(orderId)).length;
  }

  async function relaySignature(req, res, chatId, model) {
    if (!served.has(chatId)) return err(res, 404, "unknown chat id");
    const up = await fetch(`${upstream}/v1/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, {
      headers: { authorization: `Bearer ${upstreamKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    send(res, up.status, Buffer.from(await up.arrayBuffer()));
  }

  /** Handles one request. `url` may carry a path with the mount prefix already removed. */
  async function handle(req, res, url = new URL(req.url, "http://x")) {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, PREFLIGHT);
        return res.end();
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") return await chat(req, res);
      if (req.method === "GET" && url.pathname === "/v1/models") {
        const l = await getListing();
        return send(res, 200, { object: "list", data: [{ id: l.model, object: "model", owned_by: seller }] });
      }
      const m = url.pathname.match(/^\/v1\/signature\/([^/]+)$/);
      if (req.method === "GET" && m) {
        // The upstream signature names the model it really ran, so the node
        // asks for the model it really ran too. A swap shows up as a mismatch.
        const l = await getListing();
        return await relaySignature(req, res, decodeURIComponent(m[1]), mode === "swap" ? swapModel : url.searchParams.get("model") || l.model);
      }
      if (req.method === "GET" && url.pathname === "/credster/info") {
        const l = await getListing();
        return send(res, 200, { listing_id: listingId, seller, model: l.model, node_key: conf.node_key, version: 1 });
      }
      const cm = url.pathname.match(/^\/credster\/claims\/(\d+)$/);
      if (req.method === "GET" && cm) {
        const c = readLines(claimsFile).find((x) => String(x.claim_id) === cm[1]);
        if (!c) return err(res, 404, "unknown claim");
        const rs = readLines(receiptsFile).filter((r) => c.seqs.includes(r.seq)).sort((a, b) => a.seq - b.seq);
        return send(res, 200, { claim_id: c.claim_id, receipts: rs.map((r) => ({ text: r.text, sig: r.sig })) });
      }
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      err(res, 404, "not found");
    } catch (e) {
      log("error", e.message);
      if (!res.headersSent) err(res, e.status || 500, e.message);
    }
  }

  async function claimOnce() {
    const pending = readLines(receiptsFile);
    const claimed = new Set(readLines(claimsFile).flatMap((c) => c.seqs));
    const byOrder = new Map();
    for (const r of pending) if (!claimed.has(r.seq)) byOrder.set(r.order, [...(byOrder.get(r.order) || []), r]);
    for (const [orderId, rs] of byOrder) {
      rs.sort((a, b) => a.seq - b.seq);
      let inT = rs.reduce((s, r) => s + r.in, 0);
      let outT = rs.reduce((s, r) => s + r.out, 0);
      if (mode === "overclaim") {
        // This seller bills the grader's probes honestly and triples everyone
        // else, so it passes grading. Only a buyer's own receipts catch it.
        const order = await getOrder(orderId).catch(() => null);
        if (!order?.trial) { inT *= 3; outT *= 3; }
      }
      const hash = receiptsHash(rs.map((r) => r.text));
      try {
        const { value, txHash } = await call(seller, "submit_claim", { order_id: orderId, in_tokens: String(inT), out_tokens: String(outT), receipts: rs.length, receipts_hash: hash });
        appendLine(claimsFile, { claim_id: value, order: orderId, seqs: rs.map((r) => r.seq), in: inT, out: outT, hash, tx: txHash, at: Date.now() });
        log(`claimed order ${orderId}: ${inT} in / ${outT} out over ${rs.length} receipts -> claim ${value} tx ${txHash}`);
      } catch (e) {
        log(`claim for order ${orderId} failed: ${e.message.slice(0, 200)}`);
        // Usage the contract will never pay (closed order, F-graded probe) is
        // marked as settled so the node stops retrying it every cycle.
        if (/order closed|close window over|not paid|exceeds remaining budget/.test(e.message)) {
          appendLine(claimsFile, { claim_id: null, order: orderId, seqs: rs.map((r) => r.seq), in: 0, out: 0, hash, unpaid: e.message.slice(0, 120), at: Date.now() });
        }
      }
    }
  }

  let timer;
  let claiming = Promise.resolve();
  const claimNow = () => (claiming = claiming.then(claimOnce));
  if (claimEverySec > 0) timer = setInterval(claimNow, claimEverySec * 1000);
  const sweep = setInterval(() => { const now = Date.now(); for (const [k, v] of seen) if (v < now) seen.delete(k); }, 60_000);
  sweep.unref();
  return {
    name, listingId, seller, mode, nodeKey: conf.node_key, handle, claimNow, log,
    close: () => { clearInterval(timer); clearInterval(sweep); },
  };
}

export function startSellerNode(cfg) {
  const { port, host = "127.0.0.1" } = cfg;
  const node = createSellerNode(cfg);
  const server = http.createServer((req, res) => node.handle(req, res));
  server.listen(port, host, () => node.log(`listing ${node.listingId} (${node.seller}) on http://${host}:${port}`));
  return { server, claimNow: node.claimNow, close: () => { node.close(); server.close(); } };
}

/** Creates the node key and the listing on chain, and writes the node config. */
export async function createListing({ name, seller, model, endpoint, askIn, askOut, capacity, bond }) {
  const { newKeyPair } = await import("./near.js");
  const file = path("nodes", name, "node.json");
  let conf = readJson(file);
  if (!conf) {
    const kp = newKeyPair();
    conf = { name, seller, node_key: kp.getPublicKey().toString(), node_secret: kp.toString() };
    writeJson(file, conf);
  }
  const { value, txHash } = await call(seller, "create_listing", {
    model, endpoint, node_key: conf.node_key, ask_in: String(askIn), ask_out: String(askOut), capacity_tokens: String(capacity),
  }, bond);
  conf.listing_id = value;
  conf.model = model;
  conf.endpoint = endpoint;
  writeJson(file, conf);
  return { listingId: value, txHash, nodeKey: conf.node_key };
}

/** Points a listing at a new endpoint. The contract clears its grade, so it is graded again. */
export async function moveListing(name, endpoint) {
  const file = path("nodes", name, "node.json");
  const conf = readJson(file);
  if (!conf?.listing_id) throw new Error(`no listed node ${name}`);
  const { txHash } = await call(conf.seller, "update_endpoint", { listing_id: String(conf.listing_id), endpoint, node_key: conf.node_key });
  conf.endpoint = endpoint;
  writeJson(file, conf);
  return { txHash };
}

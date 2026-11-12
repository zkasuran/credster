// Buyer client: opens orders (spot, tab, bargain), calls a seller node with
// signed requests, keeps the node's signed receipts, and audits claims.
import { view, call, newKeyPair, keyPairFrom } from "./near.js";
import { signRequest, verifyReceipt } from "./sign.js";
import { path, appendLine, readLines, readJson, writeJson } from "./store.js";

export class Buyer {
  constructor(accountId) {
    this.accountId = accountId;
    this.dir = ["buyers", accountId];
  }

  _keys() {
    return readJson(path(...this.dir, "order-keys.json"), {});
  }

  /** One fresh ed25519 key per order. The secret stays in ~/.credster. */
  _newOrderKey(tag) {
    const kp = newKeyPair();
    const keys = this._keys();
    keys["pending:" + tag] = kp.toString();
    writeJson(path(...this.dir, "order-keys.json"), keys);
    return kp;
  }

  _bind(tag, orderId) {
    const keys = this._keys();
    keys[String(orderId)] = keys["pending:" + tag];
    delete keys["pending:" + tag];
    writeJson(path(...this.dir, "order-keys.json"), keys);
  }

  orderKey(orderId) {
    const s = this._keys()[String(orderId)];
    if (!s) throw new Error(`no key for order ${orderId}`);
    return keyPairFrom(s);
  }

  async buySpot(listingId, depositYocto) {
    const tag = `spot-${listingId}-${Date.now()}`;
    const kp = this._newOrderKey(tag);
    const r = await call(this.accountId, "buy_spot", { listing_id: String(listingId), buyer_key: kp.getPublicKey().toString() }, depositYocto);
    this._bind(tag, r.value);
    return r;
  }

  async openTab(listingId, ceilingIn, ceilingOut, depositYocto) {
    const tag = `tab-${listingId}-${Date.now()}`;
    const kp = this._newOrderKey(tag);
    const r = await call(this.accountId, "open_tab", { listing_id: String(listingId), ceiling_in: String(ceilingIn), ceiling_out: String(ceilingOut), buyer_key: kp.getPublicKey().toString() }, depositYocto);
    this._bind(tag, r.value);
    return r;
  }

  async makeOffer(listingId, priceIn, priceOut, note, depositYocto, ttlSec = 900) {
    const tag = `offer-${listingId}-${Date.now()}`;
    const kp = this._newOrderKey(tag);
    const r = await call(this.accountId, "make_offer", { listing_id: String(listingId), price_in: String(priceIn), price_out: String(priceOut), buyer_key: kp.getPublicKey().toString(), note, ttl_sec: ttlSec }, depositYocto);
    const keys = this._keys();
    keys["offer:" + r.value] = keys["pending:" + tag];
    delete keys["pending:" + tag];
    writeJson(path(...this.dir, "order-keys.json"), keys);
    return r;
  }

  /** After the offer is accepted, the order uses the key from the offer. */
  bindOffer(offerId, orderId) {
    const keys = this._keys();
    if (keys["offer:" + offerId]) {
      keys[String(orderId)] = keys["offer:" + offerId];
      writeJson(path(...this.dir, "order-keys.json"), keys);
    }
  }

  /**
   * Sends one chat completion through the seller node. Returns the parsed
   * answer, the verified receipt and the raw bytes (the grader needs those).
   */
  async chat(orderId, body, { endpoint, nodeKey } = {}) {
    const order = await view("get_order", { order_id: String(orderId) });
    const listing = await view("get_listing", { listing_id: String(order.listing_id) });
    endpoint = endpoint || listing.endpoint;
    nodeKey = nodeKey || listing.node_key;
    const bytes = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const headers = { "content-type": "application/json", ...signRequest(this.orderKey(orderId), orderId, bytes) };
    const t0 = Date.now();
    const res = await fetch(`${endpoint.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers, body: bytes, signal: AbortSignal.timeout(180_000) });
    const raw = Buffer.from(await res.arrayBuffer());
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, status: res.status, error: raw.toString().slice(0, 300), ms, requestBytes: bytes, raw };
    const text = Buffer.from(res.headers.get("x-ts-receipt") || "", "base64").toString();
    const sig = res.headers.get("x-ts-receipt-sig") || "";
    const receiptOk = !!text && verifyReceipt(nodeKey, text, sig);
    const receipt = text ? JSON.parse(text) : null;
    if (receipt) appendLine(path(...this.dir, `receipts-${orderId}.jsonl`), { text, sig, ok: receiptOk });
    return { ok: true, status: res.status, json: JSON.parse(raw), receipt, receiptOk, ms, requestBytes: bytes, raw };
  }

  receipts(orderId) {
    return readLines(path(...this.dir, `receipts-${orderId}.jsonl`)).filter((r) => r.ok).map((r) => JSON.parse(r.text));
  }

  /**
   * Compares the seller's claims with the receipts this buyer holds.
   * Returns the claims that ask for more tokens than the receipts cover.
   */
  async audit(orderId) {
    const mine = this.receipts(orderId);
    const haveIn = mine.reduce((s, r) => s + r.in, 0);
    const haveOut = mine.reduce((s, r) => s + r.out, 0);
    const all = await view("get_claims", { from: 0, limit: 100 });
    const claims = all.filter((c) => String(c.order_id) === String(orderId) && c.status !== "Rejected").sort((a, b) => Number(a.id) - Number(b.id));
    let accIn = 0, accOut = 0;
    const bad = [];
    for (const c of claims) {
      accIn += Number(c.in_tokens);
      accOut += Number(c.out_tokens);
      if ((accIn > haveIn || accOut > haveOut) && c.status === "Pending") {
        bad.push({ claim: c, reason: `claims total ${accIn} in / ${accOut} out, signed receipts cover ${haveIn} in / ${haveOut} out` });
      }
    }
    return { receipts: mine.length, haveIn, haveOut, claims, bad };
  }

  dispute(claimId, reason) {
    return call(this.accountId, "dispute_claim", { claim_id: String(claimId), reason: reason.slice(0, 280) });
  }

  close(orderId) {
    return call(this.accountId, "close_order", { order_id: String(orderId) });
  }
}

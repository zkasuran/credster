// Buyer client: opens orders (spot, tab, bargain), calls a seller node with
// signed requests, keeps the node's signed receipts, and audits claims.
import { view, viewAll, call, newKeyPair, keyPairFrom } from "./near.js";
import { signRequest, verifyReceipt, sha256hex } from "./sign.js";
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

  /**
   * Finds the key for an order, including one opened when the seller accepted
   * this buyer's offer (the order then carries the offer's key).
   */
  async orderKeyFor(orderId) {
    if (this._keys()[String(orderId)]) return this.orderKey(orderId);
    for (const o of await viewAll("get_offers")) {
      if (o.buyer === this.accountId && String(o.order_id) === String(orderId)) this.bindOffer(o.id, orderId);
    }
    return this.orderKey(orderId);
  }

  async counter(offerId, priceIn, priceOut, note) {
    return call(this.accountId, "counter_offer", { offer_id: String(offerId), price_in: String(priceIn), price_out: String(priceOut), note: String(note).slice(0, 280) });
  }

  async accept(offerId) {
    const r = await call(this.accountId, "accept_offer", { offer_id: String(offerId) });
    this.bindOffer(offerId, r.value);
    return r;
  }

  endOffer(offerId) {
    return call(this.accountId, "end_offer", { offer_id: String(offerId) });
  }

  settle(orderId) {
    return call(this.accountId, "settle_close", { order_id: String(orderId) });
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
  async chat(orderId, body, { endpoint, nodeKey, tee = false } = {}) {
    const order = await view("get_order", { order_id: String(orderId) });
    const listing = await view("get_listing", { listing_id: String(order.listing_id) });
    endpoint = endpoint || listing.endpoint;
    nodeKey = nodeKey || listing.node_key;
    const bytes = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const headers = { "content-type": "application/json", ...signRequest(await this.orderKeyFor(orderId), orderId, bytes) };
    const t0 = Date.now();
    const res = await fetch(`${endpoint.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers, body: bytes, signal: AbortSignal.timeout(180_000) });
    const raw = Buffer.from(await res.arrayBuffer());
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, status: res.status, error: raw.toString().slice(0, 300), ms, requestBytes: bytes, raw };
    const text = Buffer.from(res.headers.get("x-ts-receipt") || "", "base64").toString();
    const sig = res.headers.get("x-ts-receipt-sig") || "";
    const receiptOk = !!text && verifyReceipt(nodeKey, text, sig);
    const receipt = text ? JSON.parse(text) : null;
    let teeResult = null;
    if (tee && receipt) {
      // Every answer from a model NEAR AI serves in a TEE should carry its signature.
      const { teeCapable, checkAnswer } = await import("./tee.js");
      teeResult = (await teeCapable(listing.model))
        ? await checkAnswer(endpoint, { chatId: receipt.chat_id, model: listing.model, reqHash: sha256hex(bytes), respHash: sha256hex(raw) })
        : { verdict: "none", reason: `NEAR AI publishes no TEE signers for ${listing.model}` };
    }
    if (receipt) appendLine(path(...this.dir, `receipts-${orderId}.jsonl`), { text, sig, ok: receiptOk, tee: teeResult?.verdict || null, tee_reason: teeResult?.reason || null });
    return { ok: true, status: res.status, json: JSON.parse(raw), receipt, receiptOk, tee: teeResult, ms, requestBytes: bytes, raw };
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
    const lines = readLines(path(...this.dir, `receipts-${orderId}.jsonl`)).filter((r) => r.ok);
    const caught = lines.find((r) => r.tee === "contradicts" || r.tee === "altered");
    const haveIn = mine.reduce((s, r) => s + r.in, 0);
    const haveOut = mine.reduce((s, r) => s + r.out, 0);
    const all = await viewAll("get_claims");
    const claims = all.filter((c) => String(c.order_id) === String(orderId) && c.status !== "Rejected").sort((a, b) => Number(a.id) - Number(b.id));
    let accIn = 0, accOut = 0;
    const bad = [];
    for (const c of claims) {
      accIn += Number(c.in_tokens);
      accOut += Number(c.out_tokens);
      if (c.status !== "Pending") continue;
      if (accIn > haveIn || accOut > haveOut) bad.push({ claim: c, reason: `claims total ${accIn} in / ${accOut} out, signed receipts cover ${haveIn} in / ${haveOut} out` });
      else if (caught) bad.push({ claim: c, reason: `TEE check on answer #${JSON.parse(caught.text).seq}: ${caught.tee_reason}` });
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

// A minimal NEAR client for the browser (and Node 20+): ed25519 keys, view
// calls, and signed function-call transactions. No wallet and no bundler:
// ed25519 comes from @noble/ed25519, sha256 from WebCrypto, and the one
// transaction shape this page sends is borsh-encoded by hand below.
import * as ed from "../vendor/noble-ed25519.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const enc = new TextEncoder();
const dec = new TextDecoder();
export const utf8 = (s) => enc.encode(s);
export const fromUtf8 = (b) => dec.decode(b);
export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function b58encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  return "1".repeat(zeros) + s;
}

export function b58decode(str) {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  let n = 0n;
  for (const c of str) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  return new Uint8Array([...new Array(zeros).fill(0), ...out]);
}

export function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
export const sha256hex = async (bytes) => toHex(await sha256(bytes));

/** An ed25519 key in NEAR's "ed25519:<base58(seed + public key)>" format. */
export class Key {
  constructor(seed, pub) { this.seed = seed; this.pub = pub; }
  static async random() {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    return new Key(seed, await ed.getPublicKeyAsync(seed));
  }
  static async fromString(s) {
    const raw = b58decode(String(s).replace(/^ed25519:/, ""));
    const seed = raw.slice(0, 32);
    return new Key(seed, raw.length === 64 ? raw.slice(32) : await ed.getPublicKeyAsync(seed));
  }
  toString() { return "ed25519:" + b58encode(new Uint8Array([...this.seed, ...this.pub])); }
  get publicKey() { return "ed25519:" + b58encode(this.pub); }
  /** The implicit account this key controls: hex of the public key. */
  get implicitAccountId() { return toHex(this.pub); }
  sign(msg) { return ed.signAsync(msg, this.seed); }
}

export async function verifyEd25519(publicKey, msg, sig) {
  try { return await ed.verifyAsync(sig, msg, b58decode(String(publicKey).replace(/^ed25519:/, ""))); } catch { return false; }
}

// ------------------------------------------------------------------- borsh
class Writer {
  constructor() { this.parts = []; }
  push(b) { this.parts.push(b); return this; }
  u8(n) { return this.push(Uint8Array.of(n)); }
  u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return this.push(b); }
  u64(n) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return this.push(b); }
  u128(n) {
    const v = BigInt(n), b = new Uint8Array(16), dv = new DataView(b.buffer);
    dv.setBigUint64(0, v & 0xffffffffffffffffn, true);
    dv.setBigUint64(8, v >> 64n, true);
    return this.push(b);
  }
  bytes(b) { return this.u32(b.length).push(b); }
  string(s) { return this.bytes(utf8(s)); }
  done() {
    const out = new Uint8Array(this.parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

/** Transaction (v0) with FunctionCall and Transfer actions, ed25519 signer. */
export function encodeTransaction({ signerId, publicKey, nonce, receiverId, blockHash, actions }) {
  const w = new Writer().string(signerId).u8(0).push(publicKey).u64(nonce).string(receiverId).push(blockHash).u32(actions.length);
  for (const a of actions) {
    if (a.functionCall) {
      const f = a.functionCall;
      w.u8(2).string(f.methodName).bytes(f.args).u64(f.gas).u128(f.deposit);
    } else if (a.transfer) {
      w.u8(3).u128(a.transfer.deposit);
    } else throw new Error("unsupported action");
  }
  return w.done();
}

// --------------------------------------------------------------------- rpc
function rpcErrorText(e) {
  const c = e.cause || {};
  const info = c.info || e.data;
  return `${c.name || e.name || "RPC error"}${info ? ": " + JSON.stringify(info).slice(0, 300) : e.message ? ": " + e.message : ""}`;
}

/** The panic text inside a failed outcome, e.g. "listing graded F". */
export function failureText(f) {
  const s = JSON.stringify(f);
  const m = s.match(/Smart contract panicked: ((?:[^"\\]|\\.)*)/);
  return m ? JSON.parse(`"${m[1]}"`) : s.slice(0, 300);
}

export const TESTNET_RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];

export class Near {
  /** `rpc` is one URL or a list; on rate limits and errors the client moves to the next. */
  constructor({ rpc = TESTNET_RPCS, contract } = {}) {
    this.urls = [].concat(rpc).filter(Boolean);
    this.i = 0;
    this.contract = contract;
  }

  async rpc(method, params) {
    let last;
    for (let attempt = 0; attempt < 6; attempt++) {
      const url = this.urls[this.i % this.urls.length];
      let r, j;
      try {
        r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "credster", method, params }) });
        j = r.status === 429 || r.status >= 500 ? null : await r.json();
      } catch (e) { last = e; }
      // A refused request (429, 5xx, -429) never reached the chain, so a retry is safe.
      const limited = !j || j.error?.code === -429 || /rate limit/i.test(j.error?.message || "");
      if (limited) {
        last ||= new Error(`RPC ${r?.status || "unreachable"}`);
        this.i++;
        await sleep(Math.min(6000, 400 * 2 ** attempt) + Math.random() * 250);
        continue;
      }
      if (j.error) throw Object.assign(new Error(rpcErrorText(j.error)), { rpc: j.error });
      return j.result;
    }
    throw last || new Error("RPC unavailable");
  }

  async view(method, args = {}, contract = this.contract) {
    const res = await this.rpc("query", { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: toB64(utf8(JSON.stringify(args))) });
    return JSON.parse(fromUtf8(Uint8Array.from(res.result)));
  }

  async viewAll(method, from = 0) {
    const out = [];
    for (let f = from; ; f += 100) {
      const page = await this.view(method, { from: f, limit: 100 });
      out.push(...page);
      if (page.length < 100) return out;
    }
  }

  /** Account state, or null when the account does not exist (yet). */
  async account(accountId) {
    try {
      return await this.rpc("query", { request_type: "view_account", finality: "final", account_id: accountId });
    } catch (e) {
      if (/UNKNOWN_ACCOUNT|does not exist/i.test(e.message)) return null;
      throw e;
    }
  }
}

/** Signs and sends transactions for one account, one at a time (nonces). */
export class Signer {
  constructor(near, accountId, key) {
    this.near = near;
    this.accountId = accountId;
    this.key = key;
    this.nonce = null;
    this.queue = Promise.resolve();
  }

  call(methodName, args = {}, { deposit = 0n, gas = 30_000_000_000_000n, receiverId = this.near.contract } = {}) {
    const action = { functionCall: { methodName, args: utf8(JSON.stringify(args)), gas: BigInt(gas), deposit: BigInt(deposit) } };
    const run = this.queue.then(() => this.send(receiverId, [action]));
    this.queue = run.catch(() => {});
    return run;
  }

  async send(receiverId, actions, retry = 0) {
    if (this.nonce === null) {
      const ak = await this.near.rpc("query", { request_type: "view_access_key", finality: "optimistic", account_id: this.accountId, public_key: this.key.publicKey });
      this.nonce = BigInt(ak.nonce);
    }
    const block = await this.near.rpc("block", { finality: "final" });
    const nonce = ++this.nonce;
    const tx = encodeTransaction({ signerId: this.accountId, publicKey: this.key.pub, nonce, receiverId, blockHash: b58decode(block.header.hash), actions });
    const hash = await sha256(tx);
    const signed = new Uint8Array([...tx, 0, ...(await this.key.sign(hash))]);
    const txHash = b58encode(hash);
    let res;
    try {
      res = await this.near.rpc("send_tx", { signed_tx_base64: toB64(signed), wait_until: "FINAL" });
    } catch (e) {
      if (/InvalidNonce/i.test(e.message) && retry < 3) { this.nonce = null; return this.send(receiverId, actions, retry + 1); }
      if (/TIMEOUT|timed out/i.test(e.message)) res = await this.waitFor(txHash);
      else throw Object.assign(e, { txHash });
    }
    const outcomes = [res.transaction_outcome, ...(res.receipts_outcome || [])];
    const failed = outcomes.map((o) => o?.outcome?.status?.Failure).find(Boolean) || res.status?.Failure;
    if (failed) throw Object.assign(new Error(failureText(failed)), { txHash });
    const v = res.status?.SuccessValue;
    let value = null;
    if (v) { const s = fromUtf8(fromB64(v)); try { value = JSON.parse(s); } catch { value = s; } }
    return { value, txHash, logs: outcomes.flatMap((o) => o?.outcome?.logs || []) };
  }

  async waitFor(txHash) {
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      try { return await this.near.rpc("tx", { tx_hash: txHash, sender_account_id: this.accountId, wait_until: "FINAL" }); } catch (e) { if (!/UNKNOWN_TRANSACTION|TIMEOUT|timed out/i.test(e.message)) throw e; }
    }
    throw new Error(`transaction ${txHash} did not finalize`);
  }
}

export const YOCTO = 10n ** 24n;
/** "0.02" NEAR -> yoctoNEAR */
export function parseNear(s) {
  const [w, f = ""] = String(s).trim().split(".");
  return BigInt(w || "0") * YOCTO + BigInt((f + "0".repeat(24)).slice(0, 24));
}
export function formatNear(y, digits = 4) {
  const v = BigInt(y || 0);
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? "-" : ""}${a / YOCTO}.${(a % YOCTO).toString().padStart(24, "0").slice(0, digits)}`;
}

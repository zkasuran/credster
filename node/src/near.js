// NEAR access: config, keys from the near CLI legacy keychain, views and calls.
import { Account, JsonRpcProvider, KeyPair, actions } from "near-api-js";
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const NETWORK = process.env.TS_NETWORK || "testnet";
// TS_RPC may list several endpoints, comma-separated; on a rate limit the
// client backs off and moves to the next one. Public testnet RPCs limit each IP.
export const RPCS = (process.env.TS_RPC || (NETWORK === "mainnet" ? "https://free.rpc.fastnear.com,https://rpc.mainnet.near.org" : "https://test.rpc.fastnear.com,https://rpc.testnet.near.org")).split(",").map((s) => s.trim()).filter(Boolean);
export const RPC = RPCS[0];
export let CONTRACT = process.env.TS_CONTRACT || "";
// Gas attached to each call. NEAR reserves its full cost up front (about 0.03 NEAR
// for 30 TGas on testnet; the unused part is refunded), so a small faucet account
// can only afford calls with a modest allowance. The contract's calls use under 15 TGas.
export const GAS = BigInt(process.env.TS_GAS || 30_000_000_000_000);
export const YOCTO = 10n ** 24n;
export const CRED_DIR = process.env.TS_CREDENTIALS || join(homedir(), ".near-credentials", NETWORK);

const providers = RPCS.map((url) => new JsonRpcProvider({ url }));
let current = 0;
export let provider = providers[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rateLimited = (e) => /429|rate limit|too many requests/i.test(String(e?.message || e) + JSON.stringify(e?.cause || ""));

function rotate() {
  if (providers.length < 2) return;
  current = (current + 1) % providers.length;
  provider = providers[current];
  accounts.clear(); // accounts hold a provider; the next call builds them on the new one
}

/**
 * Runs an RPC operation, backing off and switching endpoints on rate limits.
 * A 429 means the request was refused, so retrying a transaction is safe.
 */
async function withRpc(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!rateLimited(e) || attempt >= 6) throw e;
      rotate();
      await sleep(Math.min(8000, 400 * 2 ** attempt) + Math.random() * 300);
    }
  }
}

export function requireContract() {
  if (!CONTRACT) throw new Error("set TS_CONTRACT to the market account, for example market.<you>.testnet");
  return CONTRACT;
}

/** Points views and calls at another market account (used by scripts/go-live.mjs). */
export function setContract(id) {
  CONTRACT = id;
  process.env.TS_CONTRACT = id;
}

/** Reads `<accountId>.json` written by `near ... save-to-legacy-keychain`. */
export function loadKey(accountId) {
  const file = join(CRED_DIR, `${accountId}.json`);
  if (!existsSync(file)) throw new Error(`no key for ${accountId} in ${CRED_DIR}`);
  const j = JSON.parse(readFileSync(file, "utf8"));
  return j.private_key || j.secret_key;
}

export const hasKey = (accountId) => existsSync(join(CRED_DIR, `${accountId}.json`));

/** Writes a key in the same legacy keychain format the near CLI uses. */
export function saveKey(accountId, keyPair) {
  mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 });
  const body = { account_id: accountId, public_key: keyPair.getPublicKey().toString(), private_key: keyPair.toString() };
  writeFileSync(join(CRED_DIR, `${accountId}.json`), JSON.stringify(body), { mode: 0o600 });
  accounts.delete(accountId);
}

// One Account object per signer, so near-api-js can track the nonce locally.
const accounts = new Map();
export function account(accountId) {
  let acc = accounts.get(accountId);
  if (!acc) {
    acc = new Account(accountId, provider, loadKey(accountId));
    accounts.set(accountId, acc);
  }
  return acc;
}

// Transactions from one signer go out one at a time; concurrent ones would
// race for the same access-key nonce.
const queues = new Map();
function serial(signerId, fn) {
  const run = (queues.get(signerId) || Promise.resolve()).then(fn);
  queues.set(signerId, run.catch(() => {}));
  return run;
}

export async function view(method, args = {}, contractId = requireContract()) {
  return withRpc(() => provider.callFunction({ contractId, method, args }));
}

export const viewCode = (contractId) => withRpc(() => provider.viewContractCode({ contractId, finality: "final" }));
export const viewAccount = (accountId) => withRpc(() => provider.viewAccount({ accountId, finality: "final" }));

/** Every item of a paged `get_*` view (`from`, `limit` <= 100). */
export async function viewAll(method, { from = 0, contractId = requireContract() } = {}) {
  const out = [];
  for (let f = from; ; f += 100) {
    const page = await view(method, { from: f, limit: 100 }, contractId);
    out.push(...page);
    if (page.length < 100) return out;
  }
}

/**
 * Calls a change method and returns { value, txHash, logs }.
 * `deposit` is yoctoNEAR (bigint or string).
 */
export async function call(signerId, method, args = {}, deposit = 0n, contractId = requireContract()) {
  return serial(signerId, async () => {
    let res;
    try {
      res = await withRpc(() => account(signerId).callFunctionRaw({ contractId, methodName: method, args, deposit: BigInt(deposit), gas: GAS, waitUntil: "FINAL" }));
    } catch (e) {
      const tx = e.transactionResult?.transaction?.hash;
      throw Object.assign(new Error(`${method} failed: ${e.panicMessage || e.message}`), { panic: e.panicMessage, txHash: tx });
    }
    const failure = findFailure(res);
    if (failure) throw new Error(`${method} failed: ${failure}`);
    return { value: successValue(res), txHash: txHashOf(res), logs: (res.receipts_outcome || []).flatMap((r) => r.outcome.logs || []) };
  });
}

/** Signs and sends raw actions (transfers, account creation, deploys). */
export async function sendActions(signerId, receiverId, acts) {
  return serial(signerId, async () => {
    let res;
    try {
      res = await withRpc(() => account(signerId).signAndSendTransaction({ receiverId, actions: acts, waitUntil: "FINAL" }));
    } catch (e) {
      throw Object.assign(new Error(`transaction to ${receiverId} failed: ${e.panicMessage || e.message}`), { txHash: e.transactionResult?.transaction?.hash });
    }
    const failure = findFailure(res);
    if (failure) throw new Error(`transaction to ${receiverId} failed: ${failure}`);
    return { value: successValue(res), txHash: txHashOf(res) };
  });
}

export const transfer = (from, to, yocto) => sendActions(from, to, [actions.transfer(BigInt(yocto))]);

/** Creates `newId` (a sub-account of `parentId`) with a fresh full-access key saved to the keychain. */
export async function createSubAccount(parentId, newId, yocto) {
  const kp = KeyPair.fromRandom("ed25519");
  saveKey(newId, kp); // saved first: a key without an account is harmless, the reverse is lost money
  const r = await sendActions(parentId, newId, [actions.createAccount(), actions.transfer(BigInt(yocto)), actions.addFullAccessKey(kp.getPublicKey())]);
  return { ...r, publicKey: kp.getPublicKey().toString() };
}

/**
 * Deletes an account and sends everything left on it to `beneficiaryId`.
 * Idempotent: near-api-js can resubmit after a slow first attempt, and the
 * resubmission then fails because the first one already deleted the account.
 */
export async function deleteAccount(accountId, beneficiaryId) {
  try {
    return await sendActions(accountId, accountId, [actions.deleteAccount(beneficiaryId)]);
  } catch (e) {
    if ((await balance(accountId)) === null) return { value: null, txHash: e.txHash || null };
    throw e;
  }
}

/** Removes a key file for an account that no longer exists. */
export function forgetKey(accountId) {
  rmSync(join(CRED_DIR, `${accountId}.json`), { force: true });
  accounts.delete(accountId);
}

export const deployContract = (accountId, code, init) =>
  sendActions(accountId, accountId, [actions.deployContract(code), ...(init ? [actions.functionCall(init.method, init.args, 100_000_000_000_000n, 0n)] : [])]);

/** Liquid balance in yoctoNEAR, or null when the account does not exist. */
export async function balance(accountId) {
  try {
    const a = await viewAccount(accountId);
    return BigInt(a.amount);
  } catch (e) {
    if (rateLimited(e)) throw e; // unknown, not "no account"
    return null;
  }
}

function successValue(res) {
  const v = res.status?.SuccessValue;
  if (v === undefined || v === "") return null;
  const raw = Buffer.from(v, "base64").toString();
  try { return JSON.parse(raw); } catch { return raw; }
}

const txHashOf = (res) => res.transaction?.hash || res.transaction_outcome?.id;

function findFailure(res) {
  const all = [res.transaction_outcome, ...(res.receipts_outcome || [])];
  for (const o of all) {
    const f = o?.outcome?.status?.Failure;
    if (f) return JSON.stringify(f).slice(0, 400);
  }
  if (res.status?.Failure) return JSON.stringify(res.status.Failure).slice(0, 400);
  return null;
}

export function events(logs) {
  return logs.filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11)));
}

export function newKeyPair() {
  return KeyPair.fromRandom("ed25519");
}

export function keyPairFrom(secret) {
  return KeyPair.fromString(secret);
}

/** NEAR as a decimal string to yoctoNEAR bigint. */
export function near(n) {
  const [w, f = ""] = String(n).split(".");
  return BigInt(w) * YOCTO + BigInt((f + "0".repeat(24)).slice(0, 24));
}

export function fmtNear(yocto, digits = 6) {
  const y = BigInt(yocto);
  const whole = y / YOCTO;
  const frac = (y % YOCTO).toString().padStart(24, "0").slice(0, digits);
  return `${whole}.${frac}`;
}

export const txUrl = (h) => `https://${NETWORK === "mainnet" ? "" : "testnet."}nearblocks.io/txns/${h}`;

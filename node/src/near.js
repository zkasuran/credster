// NEAR access: config, keys from the near CLI legacy keychain, views and calls.
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const NETWORK = process.env.TS_NETWORK || "testnet";
export const RPC = process.env.TS_RPC || (NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");
export const CONTRACT = process.env.TS_CONTRACT || "";
export const GAS = 100_000_000_000_000n; // 100 TGas
export const YOCTO = 10n ** 24n;

export const provider = new JsonRpcProvider({ url: RPC });

export function requireContract() {
  if (!CONTRACT) throw new Error("set TS_CONTRACT to the market account, for example market.<you>.testnet");
  return CONTRACT;
}

/** Reads `<accountId>.json` written by `near ... save-to-legacy-keychain`. */
export function loadKey(accountId) {
  const dir = process.env.TS_CREDENTIALS || join(homedir(), ".near-credentials", NETWORK);
  const file = join(dir, `${accountId}.json`);
  if (!existsSync(file)) throw new Error(`no key for ${accountId} in ${dir}`);
  const j = JSON.parse(readFileSync(file, "utf8"));
  return j.private_key || j.secret_key;
}

export function account(accountId) {
  return new Account(accountId, provider, loadKey(accountId));
}

export async function view(method, args = {}, contractId = requireContract()) {
  return provider.callFunction({ contractId, method, args });
}

/**
 * Calls a change method and returns { value, txHash, logs }.
 * `deposit` is yoctoNEAR (bigint or string).
 */
export async function call(signerId, method, args = {}, deposit = 0n, contractId = requireContract()) {
  const acc = account(signerId);
  let res;
  try {
    res = await acc.callFunctionRaw({ contractId, methodName: method, args, deposit: BigInt(deposit), gas: GAS, waitUntil: "FINAL" });
  } catch (e) {
    const tx = e.transactionResult?.transaction?.hash;
    throw Object.assign(new Error(`${method} failed: ${e.panicMessage || e.message}`), { panic: e.panicMessage, txHash: tx });
  }
  const status = res.status || {};
  const failure = findFailure(res);
  if (failure) throw new Error(`${method} failed: ${failure}`);
  let value = null;
  if (status.SuccessValue !== undefined && status.SuccessValue !== "") {
    const raw = Buffer.from(status.SuccessValue, "base64").toString();
    try { value = JSON.parse(raw); } catch { value = raw; }
  }
  const logs = (res.receipts_outcome || []).flatMap((r) => r.outcome.logs || []);
  return { value, txHash: res.transaction?.hash || res.transaction_outcome?.id, logs };
}

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

export const txUrl = (h) => `https://testnet.nearblocks.io/txns/${h}`;

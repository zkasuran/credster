// Read-only access to the Credster contract over NEAR testnet RPC. No backend, no key.

export const CONTRACT = "market.credster-68480.testnet";
const RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
const YOCTO = 10n ** 24n;

async function query(rpc, method, args) {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "query",
      params: { request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: method, args_base64: btoa(JSON.stringify(args)) },
    }),
  });
  const j = await r.json();
  if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error || j.result.error).slice(0, 160));
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
}

/** Calls a view method, falling back to the second RPC if the first fails. */
export async function view(method, args = {}) {
  let err;
  for (const rpc of RPCS) {
    try { return await query(rpc, method, args); } catch (e) { err = e; }
  }
  throw err;
}

async function all(method) {
  const out = [];
  for (let from = 0; ; from += 100) {
    const page = await view(method, { from, limit: 100 });
    out.push(...page);
    if (page.length < 100) return out;
  }
}

let listingsPromise;
/** All listings, fetched once per page load. */
export function listings() {
  listingsPromise ??= all("get_listings").catch((e) => { listingsPromise = undefined; throw e; });
  return listingsPromise;
}

export const stats = () => view("get_stats");

/** yoctoNEAR string to a decimal string with `d` places. */
export function near(y, d = 4) {
  const v = BigInt(y || 0);
  return `${v / YOCTO}.${(v % YOCTO).toString().padStart(24, "0").slice(0, d)}`;
}

/** sha256 of the exact bytes served at `url`, as lowercase hex. */
export async function sha256OfUrl(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${r.status} for ${url}`);
  const digest = await crypto.subtle.digest("SHA-256", await r.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const short = (h, a = 8, b = 8) => (h && h.length > a + b + 1 ? `${h.slice(0, a)}…${h.slice(-b)}` : h || "");

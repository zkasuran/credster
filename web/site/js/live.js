// Credster live: trade on the testnet market from the browser.
// Talks to NEAR RPC directly (near-lite.js), to seller nodes directly (signed
// requests, verified receipts), and to the live server only for the faucet,
// seller launches and the keeper's activity feed.
import { Near, Signer, Key, utf8, fromUtf8, toB64, fromB64, sha256hex, verifyEd25519, parseNear, formatNear, TESTNET_RPCS } from "./near-lite.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const params = new URLSearchParams(location.search);
// The live server's address. Empty means this page is served by it (same origin);
// a copy of the site hosted elsewhere sets <meta name="credster-api"> or ?api=.
const API = (params.get("api") || document.querySelector('meta[name="credster-api"]')?.content || "").replace(/\/$/, "");
const DEFAULT_CONTRACT = "market.credster-68480.testnet";
const NB = "https://testnet.nearblocks.io";
const TIER = { A: "TEE-signed", B: "no TEE for this model", C: "capped", F: "suspended" };
const PLAN = { A: 0.9, B: 0.8, C: 0.6 };
const NS = 1_000_000n;
const HONEST = new Set(["honest", "deepseek"]);
// Per-model request options that keep a reasoning model's thinking short, so a chat
// answer fits the node's token cap. Measured on NEAR AI Cloud, 12 Nov 2026: with 512
// tokens and no option, glm-5.3-flash spent all 512 thinking and returned nothing.
const BRIEF = [
  ["z-ai/", { reasoning_effort: "low" }],
  ["Qwen/", { chat_template_kwargs: { enable_thinking: false } }],
];
const briefFor = (model) => (BRIEF.find(([p]) => String(model).startsWith(p)) || [, {}])[1];
const SUGGEST = ["In one sentence, what is a NEAR sub-account?", "Name two uses of a function-call access key, one line each.", "Write a four-line poem about honest metering."];

const S = {
  status: null, near: null, contract: null, cfg: null, wallet: null, balance: undefined,
  listings: [], hosted: new Map(), selected: null, mode: "spot", deposit: "0.02",
  active: null, order: null, claims: [], offer: null, offerData: null, launches: [], reports: new Map(), sending: false,
};

// ------------------------------------------------------------------ storage
const ls = {
  k: (k) => `credster:${S.contract}:${k}`,
  get(k, d) { try { const v = localStorage.getItem(this.k(k)); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(this.k(k), JSON.stringify(v)); } catch {} },
  del(k) { localStorage.removeItem(this.k(k)); },
};
const orders = () => ls.get("orders", {});
const saveOrder = (id, rec) => ls.set("orders", { ...orders(), [id]: rec });
const offers = () => ls.get("offers", {});
const receipts = (id) => ls.get(`receipts:${id}`, []);
const convo = (id) => ls.get(`chat:${id}`, []);
const disputed = (id) => ls.get(`disputed:${id}`, {});

// ------------------------------------------------------------------ helpers
const perM = (y) => formatNear(y, 4);
const nearStr = (y, d = 4) => `${formatNear(y, d)} NEAR`;
// Implicit accounts (64 hex) and very long names get shortened; sub-accounts of
// the market's parent show their first label (s-honest.<parent> -> s-honest).
const short = (a) => {
  a = String(a || "");
  const parent = String(S.contract || "").replace(/^market\./, "");
  if (parent && a.endsWith("." + parent) && a !== S.contract) return a.slice(0, -parent.length - 1);
  return /^[0-9a-f]{64}$/.test(a) || a.length > 40 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
};
const modelShort = (m) => String(m).split("/").pop();
const mark = (t) => (t ? `<svg class="hm hm-${t}" viewBox="0 0 100 100" role="img" aria-label="Grade ${t}"><use href="#hm-${t}"/></svg>` : `<svg class="hm hm-none" viewBox="0 0 100 100" role="img" aria-label="Not graded yet"><use href="#hm-none"/></svg>`);
const txLink = (h, label = "tx") => (h ? `<a class="tx" href="${NB}/txns/${esc(h)}" target="_blank" rel="noopener">${esc(label)}<svg><use href="#i-out"/></svg></a>` : "");
const acctLink = (a) => `<a href="${NB}/address/${esc(a)}" target="_blank" rel="noopener">${esc(short(a))}</a>`;
const listing = (id) => S.listings.find((l) => String(l.id) === String(id));
const nowNs = () => BigInt(Date.now()) * NS;
const windowNs = () => BigInt(S.cfg?.challenge_window_sec ?? 60) * 1_000_000_000n;
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

let toastTimer;
function toast(html, kind = "") {
  const t = $("[data-toast]");
  t.innerHTML = html;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 7000);
}

/** Spinner and label on `btn` while `fn` runs; errors become a toast and are rethrown. */
async function busy(btn, label, fn) {
  const old = btn.innerHTML;
  btn.classList.add("is-busy");
  btn.disabled = true;
  if (label) btn.textContent = label;
  try {
    return await fn();
  } catch (e) {
    toast(esc(e.message || e), "bad");
    throw e;
  } finally {
    if (btn.isConnected) { btn.classList.remove("is-busy"); btn.disabled = false; btn.innerHTML = old; }
  }
}

function focusCard(sel) {
  const el = $(sel);
  el.hidden = false;
  $$(".lcard.is-focus").forEach((x) => x.classList.remove("is-focus"));
  el.classList.add("is-focus");
  el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

async function api(path, body) {
  const r = await fetch(`${API}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || j.error || `HTTP ${r.status}`);
  return j;
}

// ------------------------------------------------------------------ listings
const isStale = (l) => l.grade && BigInt(l.grade.graded_at) / NS + BigInt(S.cfg.max_grade_age_sec) * 1000n < BigInt(Date.now());
const tradable = (l) => l.status === "Active" && l.grade && l.grade.tier !== "F" && !isStale(l) && BigInt(l.capacity_tokens) > 0n;

function stateOf(l) {
  if (l.status === "Suspended") return ["bad", "Suspended: graded F"];
  if (l.status === "Paused") return ["warn", "Paused by the seller"];
  if (S.status?.keeper?.grading?.listing === String(l.id)) return ["warn", "Being graded right now"];
  if (!l.grade) return ["warn", "Waiting for the grader"];
  if (isStale(l)) return ["warn", "Grade expired; re-grading soon"];
  return ["ok", `Graded ${l.grade.tier}: ${TIER[l.grade.tier]}`];
}

async function loadListings() {
  S.listings = await S.near.viewAll("get_listings"); // closed ones too: old orders still point at them
  renderSellers();
  renderStatus();
  renderLaunches();
}

function renderSellers() {
  const el = $("[data-sellers]");
  const rank = (l) => (tradable(l) ? { A: 0, B: 1, C: 2 }[l.grade.tier] : l.status === "Active" ? 3 : l.status === "Paused" ? 4 : 5);
  const mine = new Set(S.launches.map((x) => String(x.listing_id)));
  const open = S.listings.filter((l) => l.status !== "Closed").sort((a, b) => rank(a) - rank(b) || Number(b.id) - Number(a.id));
  const row = (l) => {
    const h = S.hosted.get(String(l.id));
    const can = tradable(l);
    const [cls, text] = stateOf(l);
    const tag = mine.has(String(l.id)) ? `<span class="tag mine">your demo seller</span>` : h ? (HONEST.has(h.persona) ? `<span class="tag honest">demo seller</span>` : `<span class="tag demo">demo · ${esc(h.title.toLowerCase())}</span>`) : "";
    const ready = can && S.wallet && S.balance > parseNear("0.012");
    const why = !can ? "This listing can't be bought right now" : !S.wallet ? "Fund your account first (step 1)" : !(S.balance > parseNear("0.012")) ? "Your account needs test NEAR" : "";
    const rep = l.grade ? `<button type="button" class="rep" data-rep="${l.id}">${S.reports.get(String(l.id))?.ok === true ? "report ✓" : "verify report"}</button>` : "";
    return `<li class="srow ${can ? "" : "is-off"} ${S.selected === String(l.id) ? "is-sel" : ""}">
      ${mark(l.grade?.tier)}
      <div class="s-main">
        <div class="s-title"><span class="s-model">${esc(modelShort(l.model))}</span><span class="s-id">#${esc(l.id)} · ${esc(short(l.seller))}</span>${tag}</div>
        <div class="s-sub"><span class="${cls}">${esc(text)}</span>${l.grade ? `<span>p50 ${esc(l.grade.p50_latency_ms)} ms</span><span>tasks ${esc(l.grade.capability_pct)}%</span>` : ""}${rep}</div>
      </div>
      <div class="s-act"><span class="s-ask">${perM(l.ask_in)} in · ${perM(l.ask_out)} out / 1M</span>
        <button type="button" class="btn btn-xs ${can ? "btn-gold" : "btn-ghost"}" data-buy="${esc(l.id)}" ${ready ? "" : `disabled title="${esc(why)}"`}>${can ? "Buy" : "Can't buy"}</button></div>
    </li>`;
  };
  const live = open.filter((l) => l.status !== "Suspended");
  const off = open.filter((l) => l.status === "Suspended");
  const wasOpen = el.querySelector("details.off-list")?.open ? "open" : "";
  el.innerHTML = (live.map(row).join("") || `<li class="empty">No listings for sale on ${esc(S.contract)} right now.</li>`)
    + (off.length ? `<li class="off-wrap"><details class="off-list" ${wasOpen}><summary>${off.length} listing${off.length > 1 ? "s" : ""} suspended after failing grading</summary><ol class="sellers">${off.map(row).join("")}</ol></details></li>` : "");
}

async function verifyReport(l) {
  const rel = l.grade.report_url.replace(/^\//, "");
  const url = /^https?:\/\//.test(l.grade.report_url) ? l.grade.report_url : API ? `${API}/${rel}` : rel;
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`report ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  const hash = await sha256hex(buf);
  const report = JSON.parse(fromUtf8(buf));
  const v = { ok: hash === l.grade.report_hash, hash, report, url };
  S.reports.set(String(l.id), v);
  return v;
}

// ------------------------------------------------------------------ status
async function pollStatus() {
  try {
    S.status = await api("/api/status");
    S.hosted = new Map(S.status.hosted.map((h) => [String(h.listing_id), h]));
  } catch {
    S.status = null;
  }
  renderStatus();
  renderEvents();
  renderLaunches();
}

function renderStatus() {
  const st = S.status;
  const k = st?.keeper;
  const forSale = S.listings.filter((l) => tradable(l)).length;
  const chips = [
    st ? `<li class="chip"><span class="dot ${k && Date.now() - k.last_settle_at < 60_000 ? "ok" : "wait"}"></span>Market open</li>`
      : `<li class="chip"><span class="dot bad"></span>Read-only: the live server is not reachable from this page</li>`,
    S.listings.length ? `<li class="chip"><b>${forSale}</b> listing${forSale === 1 ? "" : "s"} for sale</li>` : "",
    k?.grading ? `<li class="chip"><span class="dot wait"></span>Grading listing <b>#${esc(k.grading.listing)}</b></li>` : "",
    `<li class="chip">Contract <a href="${NB}/address/${esc(S.contract)}" target="_blank" rel="noopener">${esc(S.contract)}</a></li>`,
  ];
  $("[data-status]").innerHTML = chips.join("");
}

function renderEvents() {
  const el = $("[data-events]");
  const evs = (S.status?.keeper?.events || []).filter((e) => e.kind !== "start").slice(-40).reverse();
  if (!evs.length) { el.innerHTML = `<li class="empty">${S.status ? "Nothing yet. Grades, payments, refunds and disputes show up here." : "The activity feed needs the live server."}</li>`; return; }
  const me = S.wallet?.accountId;
  const mineOrders = new Set(Object.keys(orders()));
  const mineListings = new Set(S.launches.map((x) => String(x.listing_id)));
  el.innerHTML = evs.map((e) => {
    const mine = (me && (e.buyer === me || String(e.text).includes(me))) || (e.order && mineOrders.has(String(e.order))) || (e.listing && mineListings.has(String(e.listing)));
    return `<li class="ev ${mine ? "mine" : ""}"><time datetime="${new Date(e.at).toISOString()}">${ago(e.at)}</time><div><span class="k-${esc(e.kind)}">${esc(e.text)}</span>${txLink(e.tx)}</div></li>`;
  }).join("");
}

// ------------------------------------------------------------------ wallet
async function loadWallet() {
  const w = ls.get("wallet");
  if (!w) return null;
  const key = await Key.fromString(w.secret);
  return { accountId: w.accountId, key, signer: new Signer(S.near, w.accountId, key) };
}

/** Updates S.balance; returns true when it changed. */
async function refreshBalance() {
  if (!S.wallet) return false;
  try {
    const a = await S.near.account(S.wallet.accountId);
    const b = a ? BigInt(a.amount) : null;
    const changed = b !== S.balance;
    S.balance = b;
    return changed;
  } catch {
    return false;
  }
}

/** Re-renders the account card unless the key export box is open (then only the balance). */
function updateWallet() {
  const box = $("[data-keybox]");
  if (box && !box.hidden) {
    const el = $(".acct-bal");
    if (el && S.balance) el.firstChild.textContent = formatNear(S.balance, 4);
    return;
  }
  renderWallet();
}

function renderWallet() {
  const el = $("[data-wallet]");
  const faucet = S.status?.faucet;
  if (!S.wallet) {
    el.innerHTML = `<p class="lcard-note">The page creates a throwaway testnet account in your browser and asks the faucet for ${faucet ? esc(formatNear(faucet.amount, 2)) : "0.1"} test NEAR. That is enough for a few small orders. The key stays in this browser.</p>
      <button type="button" class="btn btn-gold" data-new-wallet ${faucet?.enabled ? "" : "disabled"}>Create an account and get test NEAR<svg><use href="#i-arrow"/></svg></button>
      ${faucet?.enabled ? "" : `<p class="lcard-note" style="margin-top:12px">${S.status ? "The faucet is off on this server." : "The faucet needs the live server."} You can still use the CLI with your own testnet account (see the box on the right).</p>`}`;
    return;
  }
  const b = S.balance;
  el.innerHTML = `<div class="acct">
      <div>
        <div class="acct-id">Account <code title="${esc(S.wallet.accountId)}">${esc(short(S.wallet.accountId))}</code>
          <button type="button" class="mini" data-copy-acct aria-label="Copy account id"><svg><use href="#i-copy"/></svg></button>
          <a class="mini" href="${NB}/address/${esc(S.wallet.accountId)}" target="_blank" rel="noopener">explorer<svg><use href="#i-out"/></svg></a></div>
        <div class="acct-bal">${b === undefined ? "…" : b === null ? "not funded yet" : esc(formatNear(b, 4))}<small>${b ? "test NEAR" : ""}</small></div>
      </div>
      <div class="acct-actions">
        <button type="button" class="mini" data-refresh-bal><svg><use href="#i-refresh"/></svg>refresh</button>
        ${faucet?.enabled && !(b > parseNear("0.06")) ? `<button type="button" class="mini" data-fund>get test NEAR</button>` : ""}
        <button type="button" class="mini" data-export>export key</button>
        <button type="button" class="mini" data-forget>forget</button>
      </div>
    </div>
    <div class="keybox" data-keybox hidden></div>`;
}

async function fund(btn) {
  await busy(btn, "Asking the faucet…", async () => {
    try {
      const r = await api("/api/faucet", { account_id: S.wallet.accountId });
      toast(`The faucet sent ${esc(formatNear(r.amount, 2))} test NEAR ${txLink(r.tx)}`, "ok");
    } catch (e) {
      toast(esc(e.message), "bad");
    }
    for (let i = 0; i < 6; i++) {
      await refreshBalance();
      if (S.balance) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }).catch(() => {});
  renderWallet();
  renderSellers();
  renderCli();
}

async function newWallet(btn) {
  const key = await Key.random();
  const accountId = key.implicitAccountId;
  ls.set("wallet", { accountId, secret: key.toString(), created: Date.now() });
  S.wallet = { accountId, key, signer: new Signer(S.near, accountId, key) };
  S.balance = null;
  await fund(btn);
}

// ------------------------------------------------------------------ order
function renderOrder() {
  const card = $("#order");
  const l = listing(S.selected);
  if (!l) { card.hidden = true; return; }
  card.hidden = false;
  const h = S.hosted.get(String(l.id));
  const t = l.grade?.tier;
  const ask = `${perM(l.ask_in)} in · ${perM(l.ask_out)} out NEAR per 1M tokens`;
  const deposits = ["0.02", "0.05"].map((d) => `<button type="button" aria-pressed="${S.deposit === d}" data-deposit="${d}">${d} NEAR</button>`).join("");
  const plan = PLAN[t] || 0.6;
  const openOut = (Number(formatNear(l.ask_out, 6)) * plan * 0.8).toFixed(4);
  let form = "";
  if (S.mode === "spot") {
    form = `<p class="lcard-note" style="margin:16px 0 0">Pay a deposit now. The price is locked at the current ask, ${esc(ask)}, and whatever you don't use comes back when you close the order.</p>
      <div class="order-go"><div class="seg" role="group" aria-label="Deposit">${deposits}</div><button type="button" class="btn btn-gold btn-sm" data-open="spot">Buy at the ask<svg><use href="#i-arrow"/></svg></button></div>`;
  } else if (S.mode === "tab") {
    form = `<p class="lcard-note" style="margin:16px 0 0">Pay as you go. Each claim is priced at the seller's ask when it is made, never above your ceiling.</p>
      <div class="form-grid">
        <label class="field"><span>Ceiling, input</span><input data-ceil-in inputmode="decimal" value="${(Number(formatNear(l.ask_in, 6)) * 1.25).toFixed(4)}"><small>NEAR per 1M tokens</small></label>
        <label class="field"><span>Ceiling, output</span><input data-ceil-out inputmode="decimal" value="${(Number(formatNear(l.ask_out, 6)) * 1.25).toFixed(4)}"><small>NEAR per 1M tokens</small></label>
      </div>
      <div class="order-go"><div class="seg" role="group" aria-label="Deposit">${deposits}</div><button type="button" class="btn btn-gold btn-sm" data-open="tab">Open the tab<svg><use href="#i-arrow"/></svg></button></div>`;
  } else {
    form = `<p class="lcard-note" style="margin:16px 0 0">Make an offer. ${h ? "The seller's agent on this server answers within a few seconds. It keeps a private floor and counters halfway toward its ask." : "The seller has to answer from its own agent or the CLI."} You and the seller get four moves between you at most.</p>
      <div class="form-grid">
        <label class="field"><span>Your price, output</span><input data-offer-out inputmode="decimal" value="${openOut}"><small>NEAR per 1M (ask ${perM(l.ask_out)}); input scales with it</small></label>
        <label class="field"><span>Note on chain</span><input data-offer-note maxlength="200" value="Tier ${esc(t || "?")} listing. Opening at ${openOut} per 1M output."></label>
      </div>
      <div class="order-go"><div class="seg" role="group" aria-label="Deposit">${deposits}</div><button type="button" class="btn btn-gold btn-sm" data-make-offer>Make the offer<svg><use href="#i-arrow"/></svg></button></div>
      <div data-offer-view></div>`;
  }
  $("[data-order]").innerHTML = `
    <div class="sel-head">${mark(t)}<div><b>${esc(l.model)}</b><span>#${esc(l.id)} · ${esc(short(l.seller))}${h ? " · " + esc(h.title) : ""} · ${esc(ask)}</span></div></div>
    <div class="seg modes-seg" role="group" aria-label="How to buy">
      ${["spot", "tab", "bargain"].map((m) => `<button type="button" aria-pressed="${S.mode === m}" data-mode="${m}">${{ spot: "Spot", tab: "Pay-as-you-go tab", bargain: "Bargain" }[m]}</button>`).join("")}
    </div>${form}`;
  if (S.mode === "bargain") renderOffer();
}

async function openOrder(kind, btn) {
  const l = listing(S.selected);
  const key = await Key.random();
  const deposit = parseNear(S.deposit);
  ls.set("pending-key", { secret: key.toString(), listingId: String(l.id), kind, at: Date.now() });
  await busy(btn, "Signing and sending…", async () => {
    let r;
    if (kind === "spot") r = await S.wallet.signer.call("buy_spot", { listing_id: String(l.id), buyer_key: key.publicKey }, { deposit });
    else {
      const ci = parseNear($("[data-ceil-in]").value), co = parseNear($("[data-ceil-out]").value);
      if (ci <= 0n || co <= 0n) throw new Error("ceilings must be above zero");
      r = await S.wallet.signer.call("open_tab", { listing_id: String(l.id), ceiling_in: ci.toString(), ceiling_out: co.toString(), buyer_key: key.publicKey }, { deposit });
    }
    const id = String(r.value);
    saveOrder(id, { secret: key.toString(), listingId: String(l.id), kind, tx: r.txHash, at: Date.now() });
    ls.del("pending-key");
    toast(`Order ${esc(id)} is open ${txLink(r.txHash)}`, "ok");
    await setActive(id);
  }).catch(() => {});
  refreshBalance().then(() => { updateWallet(); renderSellers(); });
}

async function makeOffer(btn) {
  const l = listing(S.selected);
  const out = parseNear($("[data-offer-out]").value);
  if (out <= 0n) return toast("Enter a price above zero", "bad");
  const pin = (BigInt(l.ask_in) * out) / BigInt(l.ask_out) || 1n;
  const key = await Key.random();
  ls.set("pending-key", { secret: key.toString(), listingId: String(l.id), kind: "offer", at: Date.now() });
  await busy(btn, "Sending the offer…", async () => {
    const r = await S.wallet.signer.call("make_offer", { listing_id: String(l.id), price_in: pin.toString(), price_out: out.toString(), buyer_key: key.publicKey, note: $("[data-offer-note]").value.slice(0, 280), ttl_sec: 900 }, { deposit: parseNear(S.deposit) });
    ls.set("offers", { ...offers(), [String(r.value)]: { secret: key.toString(), listingId: String(l.id), at: Date.now() } });
    ls.del("pending-key");
    S.offer = String(r.value);
    ls.set("offer", S.offer);
    toast(`Offer ${esc(r.value)} is on chain ${txLink(r.txHash)}`, "ok");
    await pollOffer();
  }).catch(() => {});
}

async function pollOffer() {
  if (!S.offer) return;
  const o = await S.near.view("get_offer", { offer_id: S.offer });
  S.offerData = o;
  if (o?.status === "Accepted" && o.order_id) {
    const rec = offers()[S.offer];
    if (rec && !orders()[String(o.order_id)]) saveOrder(String(o.order_id), { secret: rec.secret, listingId: rec.listingId, kind: "Negotiated", offerId: S.offer, at: Date.now() });
    S.offer = null;
    ls.del("offer");
    toast(`Deal: offer accepted, order ${esc(o.order_id)} opened at the agreed price`, "ok");
    renderOffer(o);
    await setActive(String(o.order_id));
    return;
  }
  if (o && o.status !== "Open") { S.offer = null; ls.del("offer"); }
  renderOffer(o);
}

function renderOffer(o = S.offerData) {
  const el = $("[data-offer-view]");
  if (!el || !o || String(o.listing_id) !== String(S.selected)) return;
  const moves = o.moves.map((m) => `<div class="move ${m.by}"><div class="move-top"><span>${m.by === "Buyer" ? "You" : "Seller agent"}</span><b>${perM(m.price_out)} out · ${perM(m.price_in)} in</b></div><p>${esc(m.note)}</p></div>`).join("");
  const last = o.moves[o.moves.length - 1];
  let act = "";
  if (o.status === "Open" && last.by === "Seller") {
    const l = listing(o.listing_id);
    const plan = l ? (Number(formatNear(l.ask_out, 6)) * (PLAN[l.grade?.tier] || 0.6)).toFixed(4) : "";
    act = `<div class="offer-actions">
      <button type="button" class="btn btn-gold btn-sm" data-offer-act="accept">Accept ${perM(last.price_out)}</button>
      ${o.moves.length < 4 ? `<button type="button" class="btn btn-ghost btn-sm" data-offer-act="counter" data-plan="${plan}">Counter at ${plan}</button>` : ""}
      <button type="button" class="btn btn-ghost btn-sm" data-offer-act="end">Walk away</button></div>`;
  } else if (o.status === "Open") act = `<p class="waiting">Waiting for the seller's move…</p><div class="offer-actions"><button type="button" class="btn btn-ghost btn-sm" data-offer-act="end">Withdraw the offer</button></div>`;
  else if (o.status === "Accepted") act = `<p class="order-done"><span class="ok">Accepted.</span> Order ${esc(o.order_id)} is open at ${perM(last.price_out)} per 1M output.</p>`;
  else act = `<p class="order-done">Offer ${esc(o.status.toLowerCase())}. Your ${nearStr(o.deposit, 2)} deposit went back to your account.</p>`;
  el.innerHTML = `<div class="moves">${moves}</div>${act}`;
}

async function offerAction(kind, btn) {
  const id = S.offer || String(S.offerData?.id);
  await busy(btn, "", async () => {
    if (kind === "accept") {
      const r = await S.wallet.signer.call("accept_offer", { offer_id: id });
      const rec = offers()[id];
      saveOrder(String(r.value), { secret: rec.secret, listingId: rec.listingId, kind: "Negotiated", offerId: id, tx: r.txHash, at: Date.now() });
      toast(`You accepted. Order ${esc(r.value)} is open ${txLink(r.txHash)}`, "ok");
    } else if (kind === "counter") {
      const l = listing(S.offerData.listing_id);
      const out = parseNear(btn.dataset.plan);
      const pin = (BigInt(l.ask_in) * out) / BigInt(l.ask_out) || 1n;
      const r = await S.wallet.signer.call("counter_offer", { offer_id: id, price_in: pin.toString(), price_out: out.toString(), note: `Above my plan. I can pay ${btn.dataset.plan} per 1M output for this tier.` });
      toast(`Counter sent ${txLink(r.txHash)}`, "ok");
    } else {
      const r = await S.wallet.signer.call("end_offer", { offer_id: id });
      toast(`Offer ended; the deposit is on its way back ${txLink(r.txHash)}`, "ok");
    }
  }).catch(() => {});
  await pollOffer();
  refreshBalance().then(() => { updateWallet(); renderSellers(); });
}

// ------------------------------------------------------------------ active order
async function setActive(id) {
  S.active = String(id);
  ls.set("active", S.active);
  $("#chat").hidden = false;
  $("#bill").hidden = false;
  // RPC nodes can lag the transaction by a block or two; wait until the order is visible.
  S.order = null;
  for (let i = 0; i < 10 && !S.order; i++) {
    await refreshOrder().catch(() => {});
    if (!S.order) await new Promise((r) => setTimeout(r, 1000));
  }
  renderConvo();
  focusCard("#chat");
}

async function refreshOrder() {
  if (!S.active) return;
  const o = await S.near.view("get_order", { order_id: S.active });
  if (!o) return;
  S.order = o;
  if (!listing(o.listing_id)) {
    const l = await S.near.view("get_listing", { listing_id: String(o.listing_id) });
    if (l) S.listings.push(l);
  }
  // Claims for an order are numbered after it opened: remember where they
  // start so each poll is one small view call.
  const rec = orders()[S.active] || {};
  if (rec.claimFrom === undefined) {
    const st = await S.near.view("get_stats");
    rec.claimFrom = Math.max(0, Number(st.claims) - 20);
    if (orders()[S.active]) saveOrder(S.active, { ...orders()[S.active], claimFrom: rec.claimFrom });
  }
  const mine = [];
  for (let from = rec.claimFrom; ; from += 100) {
    const page = await S.near.view("get_claims", { from, limit: 100 });
    mine.push(...page.filter((c) => String(c.order_id) === S.active));
    if (page.length < 100) break;
  }
  S.claims = mine.sort((a, b) => Number(a.id) - Number(b.id));
  await autoDispute();
  renderBudget();
  renderBill();
}

function renderBudget() {
  const o = S.order;
  if (!o) return;
  const l = listing(o.listing_id);
  const left = BigInt(o.deposit) - BigInt(o.spent) - BigInt(o.pending);
  const pct = Number(((BigInt(o.spent) + BigInt(o.pending)) * 10000n) / (BigInt(o.deposit) || 1n)) / 100;
  $("[data-chat-meta]").innerHTML = `order #${esc(o.id)} · ${esc(o.kind === "OnDemand" ? "tab" : o.kind.toLowerCase())} · ${esc(l ? modelShort(l.model) : "")} · ${esc(o.status)}`;
  $("[data-budget]").innerHTML = `
    <div><span>Deposit</span><b>${formatNear(o.deposit, 4)}</b></div>
    <div><span>Paid to seller</span><b>${formatNear(o.spent, 6)}</b></div>
    <div><span>Claimed, pending</span><b>${formatNear(o.pending, 6)}</b></div>
    <div><span>Left</span><b>${formatNear(left, 4)}</b></div>
    <div class="bar"><i style="width:${Math.min(100, pct)}%"></i></div>`;
  const closed = o.status !== "Open";
  $("[data-composer] textarea").disabled = closed;
  $("[data-send]").disabled = closed || S.sending;
  $("[data-suggest]").innerHTML = closed ? `<p class="lcard-note">This order is ${esc(o.status.toLowerCase())}; the seller node refuses closed orders.</p>` : SUGGEST.map((s) => `<button type="button" data-suggestion="${esc(s)}">${esc(s)}</button>`).join("");
}

function renderConvo() {
  const el = $("[data-convo]");
  el.innerHTML = convo(S.active).map((m) => {
    if (m.role === "user") return `<li class="msg-u">${esc(m.content)}</li>`;
    if (m.error) return `<li class="msg-a is-err"><div class="text">${esc(m.error)}</div></li>`;
    if (m.wait) return `<li class="msg-a is-wait"><div class="text">Waiting for the seller node…</div></li>`;
    const r = m.receipt;
    const c = m.checks || {};
    const ok = (b, t) => `<span class="${b ? "ok" : "bad"}">${b ? "✓" : "✗"} ${esc(t)}</span>`;
    return `<li class="msg-a"><div class="text${m.empty ? " is-empty" : ""}">${esc(m.content)}</div>
      ${r ? `<div class="receipt"><span>receipt #${esc(r.seq)} · ${esc(r.in)} in / ${esc(r.out)} out · ${esc(m.ms)} ms</span>
        ${ok(c.sig, "signed by the node key on chain")}${ok(c.req, "request hash")}${ok(c.resp, "response hash")}
        <details><summary>receipt text</summary><pre>${esc(m.text)}</pre></details></div>` : `<div class="receipt"><span class="bad">✗ no receipt came with this answer</span></div>`}
    </li>`;
  }).join("");
  el.scrollTop = el.scrollHeight;
}

async function sendPrompt(prompt) {
  if (S.sending || !S.active || !prompt.trim()) return;
  const id = S.active;
  if (!S.order || String(S.order.id) !== id) await refreshOrder().catch(() => {});
  const o = S.order;
  if (!o) return toast("The order is not visible on NEAR RPC yet. Try again in a few seconds.", "info");
  const l = listing(o.listing_id);
  if (!l) return toast("Still loading this order's listing. Try again in a few seconds.", "info");
  const rec = orders()[id];
  if (!rec) return toast("This browser doesn't hold the key for this order.", "bad");
  if (location.protocol === "https:" && /^http:/.test(l.endpoint)) return toast(`This seller's endpoint (${esc(l.endpoint)}) is plain HTTP, which an HTTPS page cannot call.`, "bad");
  S.sending = true;
  renderBudget();
  const key = await Key.fromString(rec.secret);
  const log = convo(id);
  const history = log.filter((m) => (m.role === "user" || m.role === "assistant") && !m.error && !m.wait && !m.empty).slice(-6).map((m) => ({ role: m.role, content: m.content }));
  const body = JSON.stringify({ model: l.model, messages: [...history, { role: "user", content: prompt.trim() }], max_tokens: S.status?.limits?.max_tokens || 1024, ...briefFor(l.model) });
  const bytes = utf8(body);
  const reqHash = await sha256hex(bytes);
  const ts = Date.now();
  const sig = await key.sign(utf8(`credster/req/v1|${id}|${ts}|${reqHash}`));
  log.push({ role: "user", content: prompt.trim() }, { wait: true });
  ls.set(`chat:${id}`, log);
  renderConvo();
  const t0 = performance.now();
  let entry;
  try {
    const res = await fetch(`${l.endpoint.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "x-ts-order": id, "x-ts-ts": String(ts), "x-ts-sig": toB64(sig) }, body: bytes });
    const raw = new Uint8Array(await res.arrayBuffer());
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) {
      let msg = `${res.status}`;
      try { const j = JSON.parse(fromUtf8(raw)); msg = j.error?.message || j.error || msg; } catch {}
      entry = { error: `The seller node refused: ${msg}` };
    } else {
      const j = JSON.parse(fromUtf8(raw));
      const rt = res.headers.get("x-ts-receipt"), rs = res.headers.get("x-ts-receipt-sig");
      const choice = j.choices?.[0] || {};
      const said = String(choice.message?.content ?? "").trim();
      const used = j.usage?.completion_tokens;
      const content = said || (choice.finish_reason === "length"
        ? `The model spent its whole ${used ? used + "-token " : ""}budget thinking and was cut off before it answered. Those tokens are still metered. Try a shorter question.`
        : "The model returned an empty answer.");
      if (rt && rs) {
        const text = fromUtf8(fromB64(rt));
        const receipt = JSON.parse(text);
        const checks = {
          sig: await verifyEd25519(l.node_key, utf8(text), fromB64(rs)),
          req: receipt.req === reqHash,
          resp: receipt.resp === (await sha256hex(raw)),
          order: String(receipt.order) === id && String(receipt.listing) === String(l.id),
        };
        const ok = checks.sig && checks.req && checks.resp && checks.order;
        ls.set(`receipts:${id}`, [...receipts(id), { text, sig: rs, ok, in: receipt.in, out: receipt.out, seq: receipt.seq }]);
        entry = { role: "assistant", content, receipt, text, checks, ms, empty: !said };
      } else entry = { role: "assistant", content, ms, empty: !said };
    }
  } catch (e) {
    entry = { error: `Could not reach the seller node at ${new URL(l.endpoint).host}: ${e.message}` };
  }
  const now = convo(id);
  now.splice(now.findIndex((m) => m.wait), 1, entry);
  ls.set(`chat:${id}`, now);
  S.sending = false;
  renderConvo();
  renderBudget();
  renderBill();
}

// ------------------------------------------------------------------ bill
function audit() {
  const rs = receipts(S.active).filter((r) => r.ok);
  const haveIn = rs.reduce((s, r) => s + r.in, 0), haveOut = rs.reduce((s, r) => s + r.out, 0);
  let accIn = 0, accOut = 0;
  const bad = [];
  for (const c of S.claims.filter((x) => x.status !== "Rejected")) {
    accIn += Number(c.in_tokens);
    accOut += Number(c.out_tokens);
    if ((accIn > haveIn || accOut > haveOut) && c.status === "Pending") bad.push({ c, reason: `claims total ${accIn} in / ${accOut} out; my signed receipts cover ${haveIn} in / ${haveOut} out` });
  }
  return { n: rs.length, haveIn, haveOut, accIn, accOut, bad };
}

const windowLeftMs = (c) => Number((BigInt(c.submitted_at) + windowNs() - nowNs()) / NS);

async function autoDispute() {
  if (!$("[data-auto-dispute]").checked || !S.wallet) return;
  const { bad } = audit();
  for (const b of bad) {
    const d = disputed(S.active);
    if (d[b.c.id] || windowLeftMs(b.c) < 3000) continue;
    ls.set(`disputed:${S.active}`, { ...d, [b.c.id]: { at: Date.now() } });
    try {
      const r = await S.wallet.signer.call("dispute_claim", { claim_id: String(b.c.id), reason: b.reason.slice(0, 280) });
      ls.set(`disputed:${S.active}`, { ...disputed(S.active), [b.c.id]: { at: Date.now(), tx: r.txHash } });
      toast(`Overclaim caught. You disputed claim ${esc(b.c.id)}: ${esc(b.reason)} ${txLink(r.txHash)}`, "ok");
    } catch (e) {
      const d2 = disputed(S.active);
      delete d2[b.c.id];
      ls.set(`disputed:${S.active}`, d2);
      toast(`Dispute failed: ${esc(e.message)}`, "bad");
    }
  }
}

function renderBill() {
  const o = S.order;
  if (!o) return;
  const a = audit();
  const d = disputed(S.active);
  const over = a.accIn > a.haveIn || a.accOut > a.haveOut;
  const rows = S.claims.map((c) => {
    const left = windowLeftMs(c);
    const st = c.status === "Pending" ? (left > 0 ? `payable in ${Math.ceil(left / 1000)} s` : "payable now") : c.status === "Disputed" ? "the grader is checking the seller's receipts" : c.status === "Rejected" ? `rejected · ${nearStr(c.slashed, 4)} of the seller's bond sent to you` : "paid to the seller";
    return `<li class="claim"><span class="cid">#${esc(c.id)}</span><span class="ctok">${esc(c.in_tokens)} in / ${esc(c.out_tokens)} out · ${formatNear(c.amount, 8)} NEAR</span><span class="st ${esc(c.status)}">${esc(c.status)}</span>
      <span class="cnote">${esc(st)}${d[c.id]?.tx ? " · " + txLink(d[c.id].tx, "your dispute") : ""}${c.resolution ? " · " + esc(c.resolution) : ""}</span></li>`;
  }).join("");
  const rejected = S.claims.filter((c) => c.status === "Rejected");
  let verdict;
  if (!S.claims.length) verdict = `<p class="lcard-note">No claims yet. The seller node claims what it served every few seconds; each claim has a ${esc(S.cfg.challenge_window_sec)} s window for you to dispute.</p>`;
  else if (rejected.length) verdict = `<p class="verdict bad">Caught: the seller claimed more than its own receipts cover. The grader rejected ${rejected.length === 1 ? "the claim" : rejected.length + " claims"} and slashed ${nearStr(rejected.reduce((s, c) => s + BigInt(c.slashed), 0n), 4)} from the seller's bond to you.</p>`;
  else if (over) verdict = `<p class="verdict bad">The claims ask for more than your receipts cover (${a.accIn} / ${a.accOut} claimed, ${a.haveIn} / ${a.haveOut} signed). ${a.bad.length && !$("[data-auto-dispute]").checked ? `<button type="button" class="btn btn-xs btn-gold" data-dispute>Dispute now</button>` : "Disputing within the window…"}</p>`;
  else verdict = `<p class="verdict ok">Every claim is covered by receipts the node signed for you.</p>`;
  let foot;
  if (o.status === "Open") foot = `<button type="button" class="btn btn-ghost btn-sm" data-close>Close the order and get the rest back</button><p>The seller gets one ${esc(S.cfg.challenge_window_sec)} s window to claim, then the keeper refunds you.</p>`;
  else if (o.status === "Closing") {
    const left = Number((BigInt(o.close_requested_at) + windowNs() - nowNs()) / NS);
    foot = `<p class="waiting">Closing. ${left > 0 ? `The seller can claim for ${Math.ceil(left / 1000)} more seconds, then the keeper refunds the rest.` : "Waiting for the keeper to settle and refund…"}</p>`;
  } else foot = `<p class="order-done"><span class="ok">Closed.</span> Spent ${nearStr(o.spent, 6)}; ${nearStr(BigInt(o.deposit) - BigInt(o.spent), 4)} came back to you.</p><button type="button" class="btn btn-gold btn-sm" data-new-order>Start another order</button>`;
  $("[data-bill]").innerHTML = `
    <div class="tally">
      <div><span>Your signed receipts</span><b>${a.haveIn} / ${a.haveOut}</b><small>${a.n} answer${a.n === 1 ? "" : "s"} · tokens in / out</small></div>
      <div class="${over ? "over" : ""}"><span>Seller claimed</span><b>${a.accIn} / ${a.accOut}</b><small>${S.claims.length} claim${S.claims.length === 1 ? "" : "s"}, not counting rejected ones</small></div>
    </div>
    <div class="bill-verdict">${verdict}</div>
    <ol class="claims">${rows}</ol>
    <div class="bill-foot">${foot}</div>`;
}

// ------------------------------------------------------------------ sell
function renderSell() {
  const el = $("[data-sell]");
  const l = S.status?.launch;
  if (!l?.enabled) {
    el.innerHTML = `<p class="lcard-note">${S.status ? "Launching sellers is off on this server." : "Launching a seller needs the live server."} To sell from your own machine, see the guide below.</p>`;
    return;
  }
  const sel = el.querySelector("input[name=persona]:checked")?.value || "honest";
  el.innerHTML = `<p class="lcard-note">No AI account handy? Start a seller on this server in one click. It gets its own NEAR account, posts its bond and lists a model. The grader checks it within about a minute. Choose an honest seller to see a listing go live. Choose one that cuts corners to see what grading does to it. Demo sellers retire after ${esc(l.ttl_min)} min.</p>
    <div class="personas" role="radiogroup" aria-label="Seller behaviour">${Object.entries(l.personas).map(([k, p]) => `
      <label class="pick"><input type="radio" name="persona" value="${esc(k)}" ${k === sel ? "checked" : ""}><b>${esc(p.title)}</b><p>${esc(p.blurb)}</p><em>Expect: ${esc(p.expect)}</em></label>`).join("")}</div>
    <div class="sell-go"><button type="button" class="btn btn-gold btn-sm" data-launch ${l.active >= l.max ? "disabled" : ""}>Start this seller<svg><use href="#i-arrow"/></svg></button><p>${esc(l.active)} of ${esc(l.max)} demo seller slots in use</p></div>
    <ol class="launches" data-launches></ol>`;
  renderLaunches();
}

async function launch(btn) {
  const persona = $("input[name=persona]:checked")?.value;
  await busy(btn, "Creating the seller…", async () => {
    const r = await api("/api/sellers", { persona });
    S.launches = [{ ...r, at: Date.now() }, ...S.launches].slice(0, 6);
    ls.set("launches", S.launches);
    toast(`Seller listed as #${esc(r.listing_id)}. The grader probes it next ${txLink(r.txs.listing)}`, "ok");
    await loadListings();
    await pollStatus();
  }).catch(() => {});
}

function renderLaunches() {
  const el = $("[data-launches]");
  if (!el) return;
  el.innerHTML = S.launches.slice(0, 4).map((x) => {
    const l = listing(x.listing_id);
    const g = S.status?.keeper?.grading;
    const grading = g?.listing === String(x.listing_id);
    const t = l?.grade?.tier;
    const rep = S.reports.get(String(x.listing_id));
    if (l?.grade && !rep) verifyReport(l).then(renderLaunches).catch(() => {});
    const persona = S.status?.launch?.personas?.[x.persona]?.title || x.persona;
    const steps = [
      `<li class="done">Seller account ${acctLink(x.seller)} ${txLink(x.txs?.account)}</li>`,
      `<li class="done">Listed as #${esc(x.listing_id)} with a 0.2 NEAR bond ${txLink(x.txs?.listing)}</li>`,
    ];
    if (t) {
      const reasons = rep?.report?.decision?.reasons || [];
      steps.push(`<li class="${t === "F" ? "bad" : "done"}">Graded <b>${esc(t)}</b>${reasons.length ? ": " + esc(reasons.join("; ")) : ""}${rep ? ` · report hash <span class="${rep.ok ? "ok" : "bad"}">${rep.ok ? "matches chain" : "MISMATCH"}</span> <a class="tx" href="${esc(rep.url)}" target="_blank" rel="noopener">report<svg><use href="#i-out"/></svg></a>` : ""}</li>`);
      steps.push(t === "F" ? `<li class="bad">Suspended. Nobody can buy from it, and the contract won't pay for the grader's probe calls.</li>` : `<li class="done">Tradable. <button type="button" class="rep" data-buy-launch="${esc(x.listing_id)}">Buy from it</button></li>`);
    } else if (!l) steps.push(`<li>Retired or closed.</li>`);
    else if (grading) steps.push(`<li class="now">The grader is probing it now<div class="probe-lines">${esc((g.lines || []).slice(-7).join("\n"))}</div></li>`);
    else steps.push(`<li class="now">Waiting for the grader${S.status?.keeper?.queue?.length ? ` (${S.status.keeper.queue.length} in the queue)` : ""}…</li>`);
    if (x.expires_at) steps.push(`<li>Retires at ${new Date(x.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</li>`);
    return `<li class="launch"><div class="launch-head">${mark(t)}<div><b>${esc(persona)} · #${esc(x.listing_id)}</b><span>${esc(modelShort(l?.model || ""))} · launched ${ago(x.at)} ago</span></div></div><ol class="tl">${steps.join("")}</ol></li>`;
  }).join("");
}

// ------------------------------------------------------------------ cli
function renderCli() {
  const server = API || location.origin;
  const me = S.wallet?.accountId || "<your-account>";
  const pick = S.listings.find((l) => tradable(l))?.id ?? "<listing>";
  const lines = [
    ["c", "# Node 22; no near CLI needed"],
    ["", "git clone https://github.com/zkasuran/credster && cd credster/node && npm install"],
    ["", `export TS_CONTRACT=${S.contract}`],
    ["c", "# a funded testnet account (or: new-account, 10 NEAR from the testnet faucet)"],
    ["", `node src/cli.js new-account --faucet ${server}`],
    ["", "node src/cli.js listings"],
    ["", `node src/cli.js buy-spot --buyer ${me} --listing ${pick} --deposit 0.02`],
    ["", `node src/cli.js chat --buyer ${me} --order <order> --prompt "hello"`],
    ["", `node src/cli.js audit --buyer ${me} --order <order> --dispute`],
    ["c", ""],
    ["c", "# sell: put a seller node in front of your own AI account (the key stays here)"],
    ["", "cloudflared tunnel --url http://localhost:8701   # gives you a public https URL"],
    ["", `node src/cli.js seller-list --name mine --seller ${me} --model Qwen/Qwen3.8-27B \\`],
    ["", "  --endpoint https://<your-tunnel>/v1 --ask-in 0.08 --ask-out 0.30 --bond 0.2"],
    ["", "TS_UPSTREAM_KEY=<your NEAR AI key> node src/cli.js seller-serve --name mine --port 8701"],
  ];
  $("[data-cli]").innerHTML = lines.map(([c, t]) => (c ? `<span class="c">${esc(t)}</span>` : esc(t))).join("\n");
}

// ------------------------------------------------------------------ events
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button, a");
  if (!t) return;
  if (t.matches("[data-new-wallet]")) return newWallet(t);
  if (t.matches("[data-fund]")) return fund(t);
  if (t.matches("[data-refresh-bal]")) { await refreshBalance(); updateWallet(); renderSellers(); return; }
  if (t.matches("[data-copy-acct]")) { navigator.clipboard?.writeText(S.wallet.accountId).then(() => toast("Account id copied", "ok")); return; }
  if (t.matches("[data-export]")) {
    const box = $("[data-keybox]");
    box.hidden = !box.hidden;
    box.innerHTML = `<p>Save this as <code>~/.near-credentials/testnet/${esc(short(S.wallet.accountId))}.json</code> (the full account id as the file name) to use the same account from the CLI. Anyone with this key controls the account.</p><pre>${esc(JSON.stringify({ account_id: S.wallet.accountId, public_key: S.wallet.key.publicKey, private_key: S.wallet.key.toString() }, null, 1))}</pre>`;
    return;
  }
  if (t.matches("[data-forget]")) {
    if (!confirm("Forget this throwaway account and its order keys? Open orders can't be used or closed from this browser afterwards.")) return;
    for (const k of Object.keys(localStorage)) if (k.startsWith(`credster:${S.contract}:`)) localStorage.removeItem(k);
    Object.assign(S, { wallet: null, balance: undefined, active: null, order: null, claims: [], offer: null, launches: [] });
    $("#chat").hidden = $("#bill").hidden = true;
    renderWallet(); renderSellers(); renderSell(); renderCli();
    return;
  }
  if (t.matches("[data-refresh-listings]")) { await loadListings(); return; }
  if (t.matches("[data-buy], [data-buy-launch]")) {
    S.selected = String(t.dataset.buy ?? t.dataset.buyLaunch);
    renderSellers();
    renderOrder();
    focusCard("#order");
    return;
  }
  if (t.matches("[data-rep]")) {
    const l = listing(t.dataset.rep);
    t.textContent = "hashing…";
    try {
      const v = await verifyReport(l);
      t.className = `rep ${v.ok ? "ok" : "bad"}`;
      t.textContent = v.ok ? "report hash ✓ matches chain" : "report hash ✗ mismatch";
      t.title = `sha256 ${v.hash}`;
    } catch (err) { t.textContent = "report unavailable"; t.title = err.message; }
    return;
  }
  if (t.matches("[data-mode]")) { S.mode = t.dataset.mode; renderOrder(); return; }
  if (t.matches("[data-deposit]")) { S.deposit = t.dataset.deposit; $$("[data-deposit]").forEach((b) => b.setAttribute("aria-pressed", String(b === t))); return; }
  if (t.matches("[data-open]")) return openOrder(t.dataset.open, t);
  if (t.matches("[data-make-offer]")) return makeOffer(t);
  if (t.matches("[data-offer-act]")) return offerAction(t.dataset.offerAct, t);
  if (t.matches("[data-suggestion]")) { $("#prompt").value = t.dataset.suggestion; $("#prompt").focus(); return; }
  if (t.matches("[data-close]")) {
    await busy(t, "Closing…", async () => {
      const r = await S.wallet.signer.call("close_order", { order_id: S.active });
      toast(`Order closing ${txLink(r.txHash)}. The refund follows after the claim window.`, "ok");
      await refreshOrder();
    }).catch(() => {});
    return;
  }
  if (t.matches("[data-dispute]")) {
    const a = audit();
    for (const b of a.bad) await busy(t, "Disputing…", () => S.wallet.signer.call("dispute_claim", { claim_id: String(b.c.id), reason: b.reason.slice(0, 280) }).then((r) => { ls.set(`disputed:${S.active}`, { ...disputed(S.active), [b.c.id]: { at: Date.now(), tx: r.txHash } }); toast(`Disputed claim ${esc(b.c.id)} ${txLink(r.txHash)}`, "ok"); })).catch(() => {});
    await refreshOrder();
    return;
  }
  if (t.matches("[data-new-order]")) {
    S.active = null; S.order = null; ls.del("active");
    $("#chat").hidden = $("#bill").hidden = true;
    focusCard("#sellers");
    return;
  }
  if (t.matches("[data-launch]")) return launch(t);
});

$("[data-composer]").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#prompt").value;
  $("#prompt").value = "";
  sendPrompt(v);
});
$("#prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("[data-composer]").requestSubmit(); }
});
$("[data-auto-dispute]").addEventListener("change", () => { renderBill(); autoDispute(); });

// ------------------------------------------------------------------ boot
function every(ms, fn) {
  setInterval(() => { if (!document.hidden) fn().catch?.(() => {}); }, ms);
}

async function boot() {
  try { S.status = await api("/api/status"); } catch { S.status = null; }
  S.contract = params.get("contract") || S.status?.contract || DEFAULT_CONTRACT;
  S.near = new Near({ rpc: S.status?.rpcs?.length ? S.status.rpcs : TESTNET_RPCS, contract: S.contract });
  S.hosted = new Map((S.status?.hosted || []).map((h) => [String(h.listing_id), h]));
  $$("[data-dash]").forEach((a) => (a.href = `market.html?contract=${encodeURIComponent(S.contract)}`));
  try { S.cfg = await S.near.view("get_config"); } catch (e) {
    $("[data-status]").innerHTML = `<li class="chip"><span class="dot bad"></span>Can't read ${esc(S.contract)} from NEAR RPC: ${esc(e.message)}</li>`;
    return;
  }
  S.wallet = await loadWallet();
  S.launches = ls.get("launches", []);
  await refreshBalance();
  renderStatus(); renderWallet(); renderSell(); renderEvents(); renderCli();
  await loadListings();
  renderCli();
  const active = ls.get("active");
  if (active && orders()[active]) {
    S.active = active;
    $("#chat").hidden = $("#bill").hidden = false;
    await refreshOrder();
    renderConvo();
  }
  const of = ls.get("offer");
  if (of) {
    S.offer = of;
    const rec = offers()[of];
    if (rec) { S.selected = rec.listingId; S.mode = "bargain"; renderOrder(); }
    await pollOffer();
  }
  let sellKey = "";
  every(5000, async () => {
    await pollStatus();
    const k = JSON.stringify([S.status?.launch?.enabled, S.status?.launch?.active, S.status?.launch?.max]);
    if (k !== sellKey) { sellKey = k; renderSell(); }
  });
  every(20000, loadListings);
  every(15000, async () => { if (await refreshBalance()) { updateWallet(); renderSellers(); } });
  every(5000, async () => { if (S.active && S.order?.status !== "Closed") await refreshOrder(); });
  every(3000, async () => { if (S.offer) await pollOffer(); });
}

// Progress strip: which buyer steps are done, which is next.
function renderSteps() {
  const items = $$("[data-steps] li");
  if (!items.length) return;
  const funded = !!S.wallet && typeof S.balance === "bigint" && S.balance > 0n;
  const done = [
    funded,
    S.selected != null || !!S.active,
    !!S.active,
    !!S.active && receipts(S.active).length > 0,
    !!S.active && (S.claims.length > 0 || S.order?.status === "Closed"),
  ];
  const now = done.indexOf(false);
  items.forEach((li, i) => {
    li.classList.toggle("is-done", done[i]);
    li.classList.toggle("is-now", i === now);
    const target = $(li.querySelector("a").getAttribute("href"));
    li.classList.toggle("is-locked", !!target?.hidden);
  });
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-steps] a");
  if (!a) return;
  const el = $(a.getAttribute("href"));
  if (el?.hidden) { e.preventDefault(); toast("Finish the step before this one first.", "info"); }
});
setInterval(() => { try { renderSteps(); } catch {} }, 800);

boot().catch((e) => {
  console.error(e);
  $("[data-status]").insertAdjacentHTML("beforeend", `<li class="chip"><span class="dot bad"></span>${esc(e.message || e)}</li>`);
});

// Credster market data: reads the contract straight from NEAR RPC. No backend.
import { Near, fromUtf8, sha256hex, formatNear, TESTNET_RPCS } from "./near-lite.js";

const RECORDED = "market.credster-68480.testnet";
const FALLBACK_LIVE = "market.credster-live-mwdmcl3xeo2.testnet";
const NB = "https://testnet.nearblocks.io";
const NS = 1_000_000n;
const params = new URLSearchParams(location.search);
const API = (params.get("api") || document.querySelector('meta[name="credster-api"]')?.content || "").replace(/\/$/, "");

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const perM = (y) => formatNear(y, 4);
const modelShort = (m) => String(m).split("/").pop();
const short = (a) => {
  a = String(a || "");
  if (/^[0-9a-f]{64}$/.test(a)) return `${a.slice(0, 6)}…${a.slice(-4)}`;
  return a.split(".")[0];
};
const mark = (t) => (t ? `<svg class="hm hm-${t}" viewBox="0 0 100 100" role="img" aria-label="Grade ${t}"><use href="#hm-${t}"/></svg>` : `<svg class="hm hm-none" viewBox="0 0 100 100" role="img" aria-label="Not graded yet"><use href="#hm-none"/></svg>`);
const TIER = { A: "TEE-signed", B: "no TEE for this model", C: "capped at C", F: "suspended" };

const S = { contract: null, liveContract: FALLBACK_LIVE, near: null, cfg: null, listings: [], offers: [], orders: [], claims: [], reports: new Map(), status: null };

async function liveContract() {
  if (!API && location.hostname !== "credster.store") return FALLBACK_LIVE;
  try {
    const r = await fetch(`${API}/api/status`, { cache: "no-store" });
    if (r.ok) { S.status = await r.json(); return S.status.contract || FALLBACK_LIVE; }
  } catch {}
  return FALLBACK_LIVE;
}

const isStale = (l) => l.grade && S.cfg && BigInt(l.grade.graded_at) / NS + BigInt(S.cfg.max_grade_age_sec) * 1000n < BigInt(Date.now());
const tradable = (l) => l.status === "Active" && l.grade && l.grade.tier !== "F" && !isStale(l) && BigInt(l.capacity_tokens) > 0n;

function stateOf(l) {
  if (l.status === "Closed") return ["", "Closed by the seller"];
  if (l.status === "Suspended") return ["bad", "Suspended: graded F"];
  if (l.status === "Paused") return ["warn", "Paused by the seller"];
  if (!l.grade) return ["warn", "Waiting for the grader"];
  if (isStale(l)) return ["warn", "Grade expired"];
  return ["ok", `Graded ${l.grade.tier}: ${TIER[l.grade.tier]}`];
}

// ------------------------------------------------------------------ render
function renderSource() {
  const which = S.contract === S.liveContract ? "The live market people trade on today" : S.contract === RECORDED ? "The recorded end-to-end run of 12 Nov 2026 that the README describes" : "A contract you entered";
  $("[data-src]").innerHTML = `${esc(which)} · <a class="tx" href="${NB}/address/${esc(S.contract)}" target="_blank" rel="noopener">${esc(S.contract)}<svg><use href="#i-out"/></svg></a>`;
  $$("[data-pick]").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.pick === "live" ? S.liveContract : RECORDED) === S.contract)));
}

function renderStats(st) {
  const open = S.listings.filter((l) => l.status !== "Closed");
  const stat = (v, k) => `<li class="m-stat"><b>${v}</b><span>${k}</span></li>`;
  const refunded = S.orders.filter((o) => o.status === "Closed").reduce((s, o) => s + BigInt(o.deposit) - BigInt(o.spent), 0n);
  $("[data-stats]").innerHTML = [
    stat(S.listings.filter(tradable).length, "listings for sale"),
    stat(open.filter((l) => l.status === "Suspended").length, "suspended by grading"),
    stat(Number(st.orders).toLocaleString(), "orders"),
    stat(Number(st.tokens_settled).toLocaleString(), "tokens settled"),
    stat(`${formatNear(st.volume_paid, 4)} <small>NEAR</small>`, "paid to sellers"),
    stat(`${formatNear(refunded, 4)} <small>NEAR</small>`, "refunded to buyers"),
  ].join("");
}

function checks(g) {
  const c = (ok, label, na) => `<span class="${na ? "na" : ok ? "ok" : "bad"}">${na ? "–" : ok ? "✓" : "✗"} ${esc(label)}</span>`;
  return `<div class="m-checks">${c(g.fingerprint_ok, "claimed model")}${c(g.metering_ok, "honest metering")}${c(g.attested, g.attested ? "TEE-signed" : "no TEE proof", !g.attested && g.tier !== "F")}${c(g.capability_pct >= 50, `tasks ${g.capability_pct}%`)}</div>`;
}

function listingRow(l) {
  const [cls, text] = stateOf(l);
  const g = l.grade;
  const rep = S.reports.get(String(l.id));
  const repBtn = g ? `<button type="button" class="rep ${rep ? (rep.ok ? "ok" : "bad") : ""}" data-rep="${esc(l.id)}">${rep ? (rep.ok ? "report ✓ matches chain" : "report ✗ mismatch") : "grade report"}</button>` : "";
  const buy = S.contract === S.liveContract && tradable(l) ? `<a class="btn btn-gold btn-xs" href="live.html#sellers">Buy</a>` : "";
  return `<li class="srow ${l.status === "Active" && g && g.tier !== "F" ? "" : "is-off"}">
    ${mark(g?.tier)}
    <div class="s-main">
      <div class="s-title"><span class="s-model">${esc(modelShort(l.model))}</span><span class="s-id">#${esc(l.id)} · ${esc(short(l.seller))}</span></div>
      <div class="s-sub"><span class="${cls}">${esc(text)}</span>${g ? `<span>p50 ${esc(g.p50_latency_ms)} ms</span><span>${Number(l.tokens_sold).toLocaleString()} tokens sold</span>` : ""}${repBtn}</div>
      ${g ? checks(g) : ""}
    </div>
    <div class="s-act"><span class="s-ask">${perM(l.ask_in)} in · ${perM(l.ask_out)} out / 1M</span>${buy}</div>
  </li>`;
}

function renderListings() {
  const el = $("[data-listings]");
  const showClosed = $("[data-show-closed]").checked;
  const rank = (l) => (tradable(l) ? { A: 0, B: 1, C: 2 }[l.grade.tier] : l.status === "Active" ? 3 : l.status === "Suspended" ? 4 : 5);
  const all = [...S.listings].sort((a, b) => rank(a) - rank(b) || Number(b.id) - Number(a.id));
  const live = all.filter((l) => l.status !== "Closed" && l.status !== "Suspended");
  const off = all.filter((l) => l.status === "Suspended");
  const closed = showClosed ? all.filter((l) => l.status === "Closed") : [];
  const wasOpen = el.querySelector("details.off-list")?.open ? "open" : "";
  el.innerHTML = (live.map(listingRow).join("") || `<li class="empty">No listings for sale on this contract right now.</li>`)
    + (off.length ? `<li class="off-wrap"><details class="off-list" ${wasOpen}><summary>${off.length} listing${off.length > 1 ? "s" : ""} suspended after failing grading</summary><ol class="sellers">${off.map(listingRow).join("")}</ol></details></li>` : "")
    + (closed.length ? `<li class="off-wrap"><p class="m-sub">Closed listings</p><ol class="sellers">${closed.map(listingRow).join("")}</ol></li>` : "");
}

function renderOffers() {
  const el = $("[data-offers]");
  if (!S.offers.length) { el.innerHTML = `<article class="lcard"><p class="lcard-note" style="margin:0">No offers on this contract yet.</p></article>`; return; }
  el.innerHTML = [...S.offers].reverse().slice(0, 12).map((o) => {
    const l = S.listings.find((x) => x.id === o.listing_id);
    const status = { Accepted: `accepted → order ${esc(o.order_id)}`, Withdrawn: "buyer walked away", Rejected: "seller declined", Expired: "expired", Open: "open" }[o.status] || o.status.toLowerCase();
    const moves = o.moves.map((m) => `<div class="move ${m.by}"><div class="move-top"><span>${m.by}</span><b>${perM(m.price_out)} <small>/ 1M out</small></b></div>${m.note ? `<p>${esc(m.note)}</p>` : ""}</div>`).join("");
    return `<article class="lcard m-offer">
      <header class="m-offer-head">${mark(l?.grade?.tier)}<div><b>${esc(modelShort(l?.model || ""))} · offer #${esc(o.id)}</b><span>listing #${esc(o.listing_id)} · buyer ${esc(short(o.buyer))} · budget ${formatNear(o.deposit, 3)} NEAR</span></div><span class="m-pill ${esc(o.status)}">${status}</span></header>
      <div class="moves">${moves}</div>
    </article>`;
  }).join("");
}

function table(el, head, rows, empty) {
  el.innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${head.length}" class="na">${empty}</td></tr>`}</tbody>`;
}

function renderMoney() {
  const kind = { Spot: "spot", OnDemand: "tab", Negotiated: "negotiated" };
  table($("[data-orders]"), ["#", "listing", "kind", "buyer", "price out / 1M", "deposit", "spent", "status"],
    [...S.orders].reverse().slice(0, 60).map((o) => `<tr><td>${esc(o.id)}</td><td>#${esc(o.listing_id)}</td><td>${kind[o.kind] || esc(o.kind)}${o.trial ? ' <span class="m-muted">trial</span>' : ""}</td><td class="mono">${esc(short(o.buyer))}</td><td class="mono">${perM(o.price_out)}</td><td class="mono">${formatNear(o.deposit, 3)}</td><td class="mono">${formatNear(o.spent, 6)}</td><td class="st-${esc(o.status)}">${esc(o.status.toLowerCase())}</td></tr>`), "No orders yet.");
  table($("[data-claims]"), ["#", "order", "tokens in / out", "amount", "status"],
    [...S.claims].reverse().slice(0, 60).map((c) => `<tr title="${esc(c.dispute_reason || c.resolution || "")}"><td>${esc(c.id)}</td><td>${esc(c.order_id)}</td><td class="mono">${Number(c.in_tokens).toLocaleString()} / ${Number(c.out_tokens).toLocaleString()}</td><td class="mono">${formatNear(c.amount, 6)}</td><td class="st-${esc(c.status)}">${esc(c.status.toLowerCase())}${c.slashed !== "0" ? ` · ${formatNear(c.slashed, 3)} slashed to buyer` : ""}</td></tr>`), "No usage claims yet.");
}

// ------------------------------------------------------------------ reports
function reportUrl(l) {
  const u = l.grade.report_url;
  if (/^https?:\/\//.test(u)) return u;
  const rel = u.replace(/^\//, "");
  // Recorded-run reports ship with this site; live ones are served by the live server.
  return S.contract === S.liveContract && API ? `${API}/${rel}` : rel;
}

async function verify(l) {
  const url = reportUrl(l);
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`report ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  const hash = await sha256hex(buf);
  const v = { ok: hash === l.grade.report_hash, hash, report: JSON.parse(fromUtf8(buf)), url };
  S.reports.set(String(l.id), v);
  return v;
}

async function showReport(id) {
  const l = S.listings.find((x) => x.id === String(id));
  const body = $("[data-report-body]");
  body.innerHTML = `<p class="lcard-note">Downloading and hashing the report…</p>`;
  $("[data-report]").showModal();
  try {
    const v = await verify(l);
    const r = v.report, fp = r.fingerprint, at = r.attestation;
    const ok = (b) => (b ? "ok" : "bad");
    body.innerHTML = `
      <header class="m-rep-head">${mark(r.decision.tier)}<div><p class="label">Grade report</p><h2 id="h-report">${esc(modelShort(r.listing.model))} · listing #${esc(r.listing.id)}</h2><span class="m-muted">seller ${esc(short(r.listing.seller))} · graded ${esc(new Date(r.graded_at).toLocaleString())}</span></div></header>
      <p class="m-hash ${ok(v.ok)}">${v.ok ? "✓ The report's sha256 matches the hash on chain" : "✗ The report's sha256 does not match the hash on chain"}<code>${esc(v.hash)}</code></p>
      ${r.decision.reasons.length ? `<ul class="m-reasons">${r.decision.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      <dl class="m-rep">
        <div><dt>Token-count fingerprint</dt><dd>observed <code>${esc(JSON.stringify(fp.observed))}</code>, reference <code>${esc(JSON.stringify(fp.reference))}</code> → <b class="${fp.verdict === "match" ? "ok" : "bad"}">${esc(fp.verdict)}</b>${fp.factor && fp.factor !== 1 ? ` (×${esc(fp.factor)})` : ""}</dd></div>
        <div><dt>TEE signature</dt><dd><b class="${at.verdict === "verified" ? "ok" : at.verdict === "contradicts" ? "bad" : ""}">${esc(at.verdict)}</b>${at.reason ? ` · ${esc(at.reason)}` : ""}</dd></div>
        <div><dt>Checkable tasks</dt><dd>${r.capability.tasks.map((t) => `<span class="${ok(t.correct)}">${t.correct ? "✓" : "✗"} ${esc(t.id)}</span>`).join(" ")} <span class="m-muted">seed ${esc(r.capability.seed)}</span></dd></div>
        <div><dt>Calls</dt><dd>${esc(r.calls.ok)} of ${esc(r.calls.total)} answered · p50 ${esc(r.calls.p50_latency_ms)} ms · receipts ${r.calls.receipts_ok ? "all verified" : "not all verified"}</dd></div>
      </dl>
      <details class="m-raw"><summary>Full report JSON</summary><pre>${esc(JSON.stringify(r, null, 2))}</pre></details>`;
  } catch (e) {
    body.innerHTML = `<p class="m-hash bad">Could not load the report: ${esc(e.message)}</p>`;
  }
  renderListings();
}

// ------------------------------------------------------------------ load
async function load(contract) {
  if (S.contract !== contract) S.reports.clear();
  S.contract = contract;
  history.replaceState(null, "", `?contract=${encodeURIComponent(contract)}`);
  renderSource();
  $("[data-stats]").innerHTML = `<li class="m-stat"><b>…</b><span>reading ${esc(contract)}</span></li>`;
  S.near = new Near({ rpc: S.status?.rpcs?.length ? S.status.rpcs : TESTNET_RPCS, contract });
  try {
    const [cfg, st, listings, offers, orders, claims] = await Promise.all([
      S.near.view("get_config"), S.near.view("get_stats"), S.near.viewAll("get_listings"), S.near.viewAll("get_offers"), S.near.viewAll("get_orders"), S.near.viewAll("get_claims"),
    ]);
    Object.assign(S, { cfg, listings, offers, orders, claims });
    renderStats(st);
    renderListings();
    renderOffers();
    renderMoney();
  } catch (e) {
    $("[data-stats]").innerHTML = `<li class="m-stat"><b>error</b><span>${esc(e.message)}</span></li>`;
  }
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.pick) load(t.dataset.pick === "live" ? S.liveContract : RECORDED);
  if (t.dataset.rep) showReport(t.dataset.rep);
});
$("[data-show-closed]").addEventListener("change", renderListings);
$("[data-other]").addEventListener("submit", (e) => {
  e.preventDefault();
  const c = e.target.c.value.trim();
  if (/^[a-z0-9._-]{2,64}$/.test(c)) load(c);
});

S.liveContract = await liveContract();
$$("[data-live]").forEach((a) => (a.href = "live.html"));
load(params.get("contract") || S.liveContract);
setInterval(() => { if (!document.hidden && S.contract === S.liveContract) load(S.contract); }, 30000);

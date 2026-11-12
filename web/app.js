// Reads the Credster contract straight from NEAR RPC. No backend.
const DEFAULT_CONTRACT = "market.credster-68480.testnet";
const RPC = "https://test.rpc.fastnear.com";
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const YOCTO = 10n ** 24n;
const near = (y, d = 4) => {
  const v = BigInt(y || 0);
  return `${v / YOCTO}.${(v % YOCTO).toString().padStart(24, "0").slice(0, d)}`;
};
const perM = (y) => near(y, 4);
let contract = params.get("contract") || DEFAULT_CONTRACT;
$("contract").value = contract;

async function view(method, args = {}) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) } }),
  });
  const j = await r.json();
  if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error || j.result.error).slice(0, 200));
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
}

async function all(method) {
  const out = [];
  for (let from = 0; ; from += 100) {
    const page = await view(method, { from, limit: 100 });
    out.push(...page);
    if (page.length < 100) return out;
  }
}

const check = (ok, label, na = false) => `<span class="${na ? "na" : ok ? "ok" : "bad"}">${esc(label)}</span>`;

function listingCard(l) {
  const g = l.grade;
  const cls = ["card", l.status === "Closed" ? "closed" : "", l.status === "Suspended" ? "suspended" : ""].join(" ");
  const checks = g
    ? [check(g.fingerprint_ok, "claimed model"), check(g.metering_ok, "honest metering"), check(g.attested, g.attested ? "TEE-signed" : "no TEE proof", !g.attested && g.tier !== "F"), check(g.capability_pct >= 50, `tasks ${g.capability_pct}%`)].join("")
    : `<span class="na">not graded yet</span>`;
  return `<article class="${cls}">
    <div class="card-top">
      <div><div class="model">${esc(l.model)}</div><div class="seller">#${esc(l.id)} · ${esc(l.seller)}</div></div>
      <div class="grade ${g ? g.tier : "none"}" title="${g ? "score " + g.score : "ungraded"}">${g ? g.tier : "–"}</div>
    </div>
    <div class="checks">${checks}</div>
    <div class="row"><span>ask per 1M in / out</span><b>${perM(l.ask_in)} / ${perM(l.ask_out)} Ⓝ</b></div>
    <div class="row"><span>p50 latency · errors</span><b>${g ? g.p50_latency_ms + " ms · " + g.error_pct + "%" : "–"}</b></div>
    <div class="row"><span>bond · sold</span><b>${near(l.bond, 3)} Ⓝ · ${Number(l.tokens_sold).toLocaleString()} tok</b></div>
    <div class="row"><span class="pill ${esc(l.status)}">${esc(l.status)}</span>${g ? `<button class="link" data-report="${esc(g.report_url)}" data-hash="${esc(g.report_hash)}">grade report →</button>` : ""}</div>
  </article>`;
}

function offerBlock(o, listings) {
  const l = listings.find((x) => x.id === o.listing_id);
  const moves = o.moves.map((m) => `<div class="move"><span class="who ${m.by}">${m.by}</span><span class="px">${perM(m.price_in)} / ${perM(m.price_out)}</span><span class="note">${esc(m.note)}</span></div>`).join("");
  return `<div class="offer">
    <div class="offer-head"><span>Offer #${esc(o.id)} on #${esc(o.listing_id)} ${esc(l?.model || "")} (grade ${esc(l?.grade?.tier || "–")}) · buyer ${esc(o.buyer)} · budget ${near(o.deposit, 3)} Ⓝ</span><span class="pill">${esc(o.status)}${o.order_id ? " → order " + esc(o.order_id) : ""}</span></div>
    <div class="moves">${moves}</div>
  </div>`;
}

function table(el, head, rows) {
  el.innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${head.length}" class="na">none</td></tr>`}</tbody>`;
}

async function showReport(url, hash) {
  const body = $("reportBody");
  body.innerHTML = "Loading…";
  $("report").showModal();
  try {
    const text = await (await fetch(url)).text();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).map((b) => b.toString(16).padStart(2, "0")).join("");
    const r = JSON.parse(text);
    const fp = r.fingerprint;
    const at = r.attestation;
    body.innerHTML = `<h2>Grade ${esc(r.decision.tier)} · listing #${esc(r.listing.id)} · ${esc(r.listing.model)}</h2>
      <p class="${digest === hash ? "ok" : "bad"}">report sha256 ${digest === hash ? "matches" : "DOES NOT match"} the hash on chain</p>
      <p class="hashline">${esc(digest)}</p>
      ${r.decision.reasons.length ? `<ul class="reasons">${r.decision.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      <h3>Token-count fingerprint</h3>
      <p>observed <code>${esc(JSON.stringify(fp.observed))}</code> · reference <code>${esc(JSON.stringify(fp.reference))}</code> → <b>${esc(fp.verdict)}</b>${fp.factor && fp.factor !== 1 ? " (×" + esc(fp.factor) + ")" : ""}${fp.looks_like?.length ? " · matches " + esc(fp.looks_like.join(", ")) : ""}</p>
      <h3>TEE signature</h3>
      <p><b>${esc(at.verdict)}</b>${at.reason ? " · " + esc(at.reason) : ""}${at.signed_model ? " · signed model " + esc(at.signed_model) : ""}</p>
      <h3>Checkable tasks (seed ${esc(r.capability.seed)})</h3>
      <p>${r.capability.tasks.map((t) => check(t.correct, t.id)).join(" ")}</p>
      <h3>Calls</h3>
      <p>${esc(r.calls.ok)}/${esc(r.calls.total)} ok · p50 ${esc(r.calls.p50_latency_ms)} ms · receipts ${r.calls.receipts_ok ? "all verified" : "NOT all verified"}</p>
      <details><summary>full report</summary><pre>${esc(text)}</pre></details>`;
  } catch (e) {
    body.innerHTML = `<p class="bad">Could not load ${esc(url)}: ${esc(e.message)}</p>`;
  }
}

async function load() {
  $("stats").innerHTML = `<div class="stat"><b>…</b><span>loading ${esc(contract)}</span></div>`;
  try {
    const [stats, listings, offers, orders, claims] = await Promise.all([view("get_stats"), all("get_listings"), all("get_offers"), all("get_orders"), all("get_claims")]);
    const graded = listings.filter((l) => l.grade);
    const stat = (v, k) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`;
    $("stats").innerHTML = [
      stat(listings.filter((l) => l.status !== "Closed").length, "open listings"),
      stat(graded.filter((l) => l.grade.tier === "F" && l.status !== "Closed").length, "suspended (F)"),
      stat(stats.orders, "orders"),
      stat(Number(stats.tokens_settled).toLocaleString(), "tokens settled"),
      stat(near(stats.volume_paid, 6) + " Ⓝ", "paid to sellers"),
      stat(near(stats.slashed_total, 6) + " Ⓝ", "slashed to buyers"),
    ].join("");
    const show = $("showClosed").checked ? listings : listings.filter((l) => l.status !== "Closed");
    const latest = show.length ? show : listings.slice(-6);
    $("listings").innerHTML = [...latest].reverse().map(listingCard).join("") || `<p class="na">No listings.</p>`;
    $("offers").innerHTML = [...offers].reverse().map((o) => offerBlock(o, listings)).join("") || `<p class="na">No offers yet.</p>`;
    table($("orders"), ["#", "listing", "kind", "buyer", "price in/out", "deposit", "spent", "status"], [...orders].reverse().map((o) => `<tr><td>${o.id}</td><td>${o.listing_id}</td><td>${o.kind}${o.trial ? " (probe)" : ""}</td><td class="mono">${esc(o.buyer.split(".")[0])}</td><td class="mono">${perM(o.price_in)}/${perM(o.price_out)}</td><td class="mono">${near(o.deposit, 3)}</td><td class="mono">${near(o.spent, 6)}</td><td>${o.status}</td></tr>`));
    table($("claims"), ["#", "order", "tokens in/out", "amount", "status", "note"], [...claims].reverse().map((c) => `<tr><td>${c.id}</td><td>${c.order_id}</td><td class="mono">${c.in_tokens}/${c.out_tokens}</td><td class="mono">${near(c.amount, 6)}</td><td class="st-${c.status}">${c.status}${c.slashed !== "0" ? " · slashed " + near(c.slashed, 6) : ""}</td><td class="wrap">${esc(c.dispute_reason || c.resolution || "")}</td></tr>`));
  } catch (e) {
    $("stats").innerHTML = `<div class="stat"><b>error</b><span>${esc(e.message)}</span></div>`;
  }
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-report]");
  if (b) showReport(b.dataset.report, b.dataset.hash);
});
$("reload").onclick = () => {
  contract = $("contract").value.trim();
  history.replaceState(null, "", `?contract=${encodeURIComponent(contract)}`);
  load();
};
$("showClosed").onchange = load;
load();

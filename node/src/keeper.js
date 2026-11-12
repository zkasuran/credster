// Keeper: the background work a public market needs so nobody has to run
// commands by hand. Two lanes run side by side.
//
// - Settle lane, every few seconds: pays claims once their challenge window
//   has passed, finishes closing orders (refunds), expires stale offers,
//   resolves disputes as the grader, and lets hosted sellers' agents answer
//   offers.
// - Grade lane: grades new listings and re-grades listings before their grade
//   goes stale, one at a time, with backoff for endpoints that do not answer.
//   Graded listings also get unannounced mystery-shopper re-grades from a fresh
//   account, and the shopper's bill is audited afterwards; a listing that
//   overclaims a shopper is suspended.
//
// Everything it does is an ordinary contract call that anyone (or the grader,
// for grades and disputes) could make; the keeper only saves the typing.
import { view, viewAll, call, balance, near, fmtNear } from "./near.js";
import { gradeListing, resolveDisputes, newShopper, auditShop, postAuditGrade } from "./grader.js";
import { deleteAccount, forgetKey } from "./near.js";
import { SellerAgent } from "./agents.js";

const NS_PER_MS = 1_000_000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const who = (a) => (/^[0-9a-f]{64}$/.test(a) ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

/** Pages through a get_* view, skipping items before the first one that can still change. */
function feed(method, isFinal) {
  let from = 0;
  return async () => {
    const items = await viewAll(method, { from });
    const open = items.find((x) => !isFinal(x));
    if (open) from = Number(open.id);
    else if (items.length) from = Number(items[items.length - 1].id) + 1;
    return items;
  };
}

export function createKeeper({
  grader,
  signer = grader, // pays gas for finalize / settle / expire; anyone may call those
  sellerFor = () => null, // listing -> hosted seller account id whose agent answers offers, or null
  settleEverySec = Number(process.env.TS_KEEPER_SETTLE_EVERY || 8),
  gradeEverySec = Number(process.env.TS_KEEPER_GRADE_EVERY || 15),
  regradeMarginSec = 2 * 3600,
  // Mystery-shopper re-grades of graded listings, at a random time inside this window after the last grade.
  mysteryMinSec = Number(process.env.TS_MYSTERY_MIN_SEC || 2 * 3600),
  mysteryMaxSec = Number(process.env.TS_MYSTERY_MAX_SEC || 4 * 3600),
  maxGradesPerDay = 300,
  gradeTimeoutMs = 10 * 60_000,
  log = console.log,
} = {}) {
  const events = [];
  const emit = (kind, text, extra = {}) => {
    const e = { at: Date.now(), kind, text, ...extra };
    events.push(e);
    if (events.length > 300) events.shift();
    log(`[keeper] ${text}${extra.tx ? " tx " + extra.tx : ""}`);
    return e;
  };
  const claimsFeed = feed("get_claims", (c) => c.status === "Paid" || c.status === "Rejected");
  const ordersFeed = feed("get_orders", (o) => o.status === "Closed");
  const offersFeed = feed("get_offers", (o) => o.status !== "Open");
  const attempts = new Map(); // listing id -> { fails, nextAt, why }
  const busy = new Set(); // "claim:1", "order:2", "offer:3": one action in flight per item
  const wanted = []; // listing ids to grade before anything else
  const shops = []; // { shopper, orderId, listingId, until, disputed: Set }
  // A stable random delay per (listing, grade time), so the next visit can't be predicted from the last.
  const mysteryDue = (l) => {
    const t = Number(BigInt(l.grade.graded_at) / NS_PER_MS);
    let h = 2166136261;
    for (const ch of `${l.id}:${l.grade.graded_at}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    return t + (mysteryMinSec + (h % 1000) / 1000 * (mysteryMaxSec - mysteryMinSec)) * 1000;
  };
  let cfg, cfgAt = 0, day = { key: "", grades: 0 }, grading = null, stopped = false, kick = () => {}, lowFundsAt = 0;
  const stats = { settleTicks: 0, gradeTicks: 0, lastSettleAt: 0, lastError: null };

  async function config() {
    if (!cfg || Date.now() - cfgAt > 10 * 60_000) { cfg = await view("get_config"); cfgAt = Date.now(); }
    return cfg;
  }

  // Both lanes read listings; one fetch serves them for a few seconds (public RPCs rate-limit).
  let listingsCache = { at: 0, items: null };
  async function allListings(maxAgeMs = 15_000) {
    if (!listingsCache.items || Date.now() - listingsCache.at > maxAgeMs) listingsCache = { at: Date.now(), items: await viewAll("get_listings") };
    return listingsCache.items;
  }

  // One action in flight per item, and a failed item waits two minutes before
  // the next try, so a call that keeps panicking does not burn gas every tick.
  const failedAt = new Map();
  async function once(key, fn) {
    if (busy.has(key) || Date.now() - (failedAt.get(key) || 0) < 120_000) return;
    busy.add(key);
    try {
      const r = await fn();
      if (r === false) failedAt.set(key, Date.now());
      return r;
    } finally { busy.delete(key); }
  }

  // ------------------------------------------------------------ settle lane
  async function settleTick() {
    const c = await config();
    const now = BigInt(Date.now()) * NS_PER_MS;
    const win = BigInt(c.challenge_window_sec) * 1_000_000_000n;
    const claims = await claimsFeed();
    const orders = await ordersFeed();
    const offers = await offersFeed();
    const listings = await allListings();
    const byListing = new Map(listings.map((l) => [String(l.id), l]));
    const orderById = new Map(orders.map((o) => [String(o.id), o]));

    // Disputes first: a buyer is waiting for the verdict.
    const disputed = claims.filter((x) => x.status === "Disputed");
    if (disputed.length) {
      await once("disputes", async () => {
        const res = await resolveDisputes({ grader, claims: disputed, log: () => {} });
        for (const r of res) {
          const cl = disputed.find((x) => String(x.id) === String(r.claim));
          const o = orderById.get(String(cl?.order_id));
          emit(r.uphold ? "dispute-upheld" : "dispute-rejected", r.uphold
            ? `claim ${r.claim} upheld: the seller's receipts cover it`
            : `claim ${r.claim} rejected; ${fmtNear(r.slash, 4)} NEAR of the seller's bond goes to ${o ? who(o.buyer) : "the buyer"}`,
            { claim: String(r.claim), order: o ? String(o.id) : undefined, listing: o ? String(o.listing_id) : undefined, buyer: o?.buyer, tx: r.tx, resolution: r.resolution });
        }
      });
    }

    for (const cl of claims.filter((x) => x.status === "Pending" && BigInt(x.submitted_at) + win + 2_000_000_000n <= now).slice(0, 8)) {
      await once(`claim:${cl.id}`, async () => {
        try {
          const r = await call(signer, "finalize_claim", { claim_id: String(cl.id) });
          const o = orderById.get(String(cl.order_id));
          emit("paid", `claim ${cl.id} paid: ${cl.in_tokens} in / ${cl.out_tokens} out, ${fmtNear(cl.amount, 6)} NEAR to the seller`, { claim: String(cl.id), order: String(cl.order_id), listing: o ? String(o.listing_id) : undefined, tx: r.txHash });
        } catch (e) { log(`[keeper] finalize ${cl.id}: ${e.message.slice(0, 160)}`); return false; }
      });
    }

    for (const o of orders.filter((x) => x.status === "Closing" && x.pending === "0").slice(0, 8)) {
      const suspended = byListing.get(String(o.listing_id))?.status === "Suspended";
      if (!suspended && BigInt(o.close_requested_at) + win + 2_000_000_000n > now) continue;
      await once(`order:${o.id}`, async () => {
        try {
          const r = await call(signer, "settle_close", { order_id: String(o.id) });
          const refund = BigInt(o.deposit) - BigInt(o.spent);
          emit("refund", `order ${o.id} closed: ${fmtNear(o.spent, 6)} NEAR spent, ${fmtNear(refund, 4)} NEAR back to ${who(o.buyer)}`, { order: String(o.id), listing: String(o.listing_id), buyer: o.buyer, tx: r.txHash });
        } catch (e) { log(`[keeper] settle ${o.id}: ${e.message.slice(0, 160)}`); return false; }
      });
    }

    for (const of of offers.filter((x) => x.status === "Open")) {
      if (BigInt(of.expires_at) < now) {
        await once(`offer:${of.id}`, async () => {
          try {
            const r = await call(signer, "end_offer", { offer_id: String(of.id) });
            emit("offer", `offer ${of.id} expired; the deposit went back to ${who(of.buyer)}`, { offer: String(of.id), listing: String(of.listing_id), buyer: of.buyer, tx: r.txHash });
          } catch (e) { log(`[keeper] expire ${of.id}: ${e.message.slice(0, 160)}`); return false; }
        });
        continue;
      }
      const l = byListing.get(String(of.listing_id));
      const seller = l && sellerFor(l);
      if (!seller || of.moves[of.moves.length - 1].by !== "Buyer") continue;
      await once(`offer:${of.id}`, async () => {
        try {
          const r = await new SellerAgent(seller, { log: () => {} }).react(of.id);
          const after = await view("get_offer", { offer_id: String(of.id) });
          const last = after.moves[after.moves.length - 1];
          const what = r.result === "accepted" ? `accepted at ${perM(last.price_out)} per 1M output, order ${r.orderId}` : r.result === "countered" ? `countered at ${perM(last.price_out)}: "${last.note}"` : r.result;
          emit("offer", `seller agent for listing ${of.listing_id} ${what}`, { offer: String(of.id), listing: String(of.listing_id), order: r.orderId ? String(r.orderId) : undefined, tx: r.tx });
        } catch (e) { log(`[keeper] seller agent on offer ${of.id}: ${e.message.slice(0, 160)}`); return false; }
      });
    }
    // Mystery-shopper bills: the seller claims within seconds; the shopper audits
    // each claim against its own receipts before the challenge window closes.
    for (const s of [...shops]) {
      if (Date.now() > s.until) {
        const o = await view("get_order", { order_id: s.orderId }).catch(() => null);
        if (o?.status === "Closed" || Date.now() > s.until + 30 * 60_000) {
          shops.splice(shops.indexOf(s), 1);
          // Grader-funded shoppers are swept back. Faucet-funded ones are left alone:
          // deleting them into the grader would link them to it after the fact.
          if (s.funding === "grader") await deleteAccount(s.shopper, grader).then(() => forgetKey(s.shopper)).catch((e) => log(`[keeper] sweep shopper: ${e.message.slice(0, 120)}`));
        }
        continue;
      }
      await once(`shop:${s.orderId}`, async () => {
        const a = await auditShop({ shopper: s.shopper, orderId: s.orderId, log: () => {} });
        for (const d of a.disputed) {
          s.disputed.add(String(d.claim));
          emit("dispute", `mystery shopper disputed claim ${d.claim} on listing ${s.listingId}: ${d.reason}`, { claim: String(d.claim), listing: s.listingId, tx: d.tx });
        }
        // Once a shopper's dispute is rejected, the listing is suspended with a report.
        for (const cid of s.disputed) {
          const cl = await view("get_claim", { claim_id: cid });
          if (cl?.status !== "Rejected" || s.suspended) continue;
          const r = await postAuditGrade({ grader, listingId: s.listingId, claim: cl, base: s.report });
          s.suspended = true;
          if (r.skipped) continue; // the shopper's grade had already suspended it
          listingsCache.at = 0;
          emit("graded", `listing ${s.listingId} graded F and suspended: ${r.reason}`, { listing: s.listingId, tier: "F", tx: r.tx, report: r.file, hash: r.hash });
        }
      });
    }
    stats.settleTicks++;
    stats.lastSettleAt = Date.now();
  }

  // ------------------------------------------------------------- grade lane
  async function pickListing() {
    const c = await config();
    const listings = await allListings(wanted.length ? 3_000 : 15_000);
    const now = Date.now();
    const staleAt = (l) => Number(BigInt(l.grade.graded_at) / NS_PER_MS) + c.max_grade_age_sec * 1000;
    const due = listings.filter((l) => l.status === "Active" && (!l.grade || staleAt(l) - regradeMarginSec * 1000 <= now || (l.grade.tier !== "F" && mysteryDue(l) <= now)));
    const ready = due.filter((l) => (attempts.get(String(l.id))?.nextAt || 0) <= now);
    const first = wanted.map((id) => ready.find((l) => String(l.id) === id)).find(Boolean);
    if (first) return first;
    const ungraded = ready.filter((l) => !l.grade).sort((a, b) => Number(b.id) - Number(a.id));
    return ungraded[0] || ready.filter((l) => l.grade).sort((a, b) => staleAt(a) - staleAt(b))[0] || null;
  }

  function backoff(id, why) {
    const a = attempts.get(id) || { fails: 0 };
    a.fails++;
    a.why = why;
    a.nextAt = Date.now() + Math.min(6 * 3600_000, 60_000 * 2 ** Math.min(a.fails, 9));
    attempts.set(id, a);
    const idx = wanted.indexOf(id);
    if (idx >= 0) wanted.splice(idx, 1);
    emit("grade-skip", `listing ${id} not graded: ${why}. Next try in ${Math.round((a.nextAt - Date.now()) / 60_000)} min`, { listing: id });
  }

  async function reachable(endpoint) {
    try {
      const r = await fetch(`${endpoint.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(8000) });
      return r.status < 500;
    } catch {
      return false;
    }
  }

  async function gradeTick() {
    const today = new Date().toISOString().slice(0, 10);
    if (day.key !== today) day = { key: today, grades: 0 };
    if (day.grades >= maxGradesPerDay) return;
    const l = await pickListing();
    if (!l) return;
    const id = String(l.id);
    const bal = await balance(grader);
    if (bal === null || bal < near("0.15")) {
      if (Date.now() - lowFundsAt > 3600_000) { lowFundsAt = Date.now(); emit("warning", `grader ${grader} is low on NEAR (${bal === null ? "no account" : fmtNear(bal, 3)}); grading paused`); }
      return;
    }
    if (!/^https?:\/\//.test(l.endpoint) || !(await reachable(l.endpoint))) return backoff(id, `endpoint ${l.endpoint} does not answer`);
    // A graded listing gets a mystery shopper: an ordinary order from a fresh account.
    let shopper = null, shopperFunding = null;
    if (l.grade) {
      try { ({ id: shopper, funding: shopperFunding } = await newShopper(grader)); } catch (e) { return backoff(id, `could not fund a mystery shopper: ${e.message.slice(0, 80)}`); }
    }
    grading = { listing: id, model: l.model, seller: l.seller, started: Date.now(), lines: [], mystery: !!shopper };
    emit("grading", shopper ? `mystery-shopper re-grade of listing ${id} (${l.model}) from a fresh ${shopperFunding === "testnet faucet" ? "faucet-funded" : "grader-funded"} account` : `grading listing ${id} (${l.model}, seller ${l.seller})`, { listing: id });
    try {
      const r = await Promise.race([
        gradeListing(id, { grader, shopper, shopperFunding, log: (line) => { grading.lines.push(String(line).trim()); if (grading.lines.length > 40) grading.lines.shift(); } }),
        sleep(gradeTimeoutMs).then(() => { throw new Error("grading timed out"); }),
      ]);
      day.grades++;
      attempts.delete(id);
      listingsCache.at = 0; // the grade changed a listing
      const idx = wanted.indexOf(id);
      if (idx >= 0) wanted.splice(idx, 1);
      const d = r.report.decision;
      if (shopper) shops.push({ shopper, funding: shopperFunding, orderId: String(r.orderId), listingId: id, report: r.file, until: Date.now() + 5 * 60_000, disputed: new Set() });
      emit("graded", `listing ${id} graded ${d.tier}${d.tier === "F" ? " and suspended" : ""}${d.reasons.length ? ": " + d.reasons.join("; ") : ""}`, { listing: id, tier: d.tier, tx: r.tx, report: r.file, hash: r.hash });
    } catch (e) {
      backoff(id, e.message.slice(0, 160));
    } finally {
      grading = null;
    }
    stats.gradeTicks++;
  }

  async function lane(name, fn, everyMs, wake) {
    while (!stopped) {
      const t0 = Date.now();
      try { await fn(); } catch (e) { stats.lastError = `${name}: ${e.message.slice(0, 200)}`; log(`[keeper] ${name} lane: ${e.message.slice(0, 200)}`); }
      const wait = Math.max(500, everyMs - (Date.now() - t0));
      await new Promise((r) => { const t = setTimeout(r, wait); if (wake) wake((fn2) => { clearTimeout(t); r(); }); });
    }
  }

  return {
    start() {
      lane("settle", settleTick, settleEverySec * 1000);
      lane("grade", gradeTick, gradeEverySec * 1000, (w) => { kick = w; });
      emit("start", `keeper started: grader ${grader}, settle every ${settleEverySec} s, grades re-done ${regradeMarginSec / 3600} h before they go stale`);
      return this;
    },
    stop() { stopped = true; },
    /** Grades this listing next (a freshly launched seller). */
    gradeSoon(listingId) {
      const id = String(listingId);
      attempts.delete(id);
      if (!wanted.includes(id)) wanted.push(id);
      kick();
    },
    emit,
    status() {
      return {
        grading: grading && { ...grading, lines: grading.lines.slice(-14) },
        queue: [...wanted],
        backoff: Object.fromEntries([...attempts].map(([k, v]) => [k, { fails: v.fails, next_at: v.nextAt, why: v.why }])),
        grades_today: day.grades,
        mystery_shops: shops.map((s) => ({ listing: s.listingId, order: s.orderId })),
        events: events.slice(-80),
        last_settle_at: stats.lastSettleAt,
        last_error: stats.lastError,
      };
    },
  };
}

const perM = (y) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(4);

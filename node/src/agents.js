// Bargaining and pricing agents. Rules decide every price; an LLM (optional)
// only writes the one-line reasoning that goes on chain with each move, so a
// prompt injection in a counterparty's note cannot move money.
import { view, call } from "./near.js";

const BPS = 10_000n;
const scale = (x, bps) => (BigInt(x) * BigInt(bps)) / BPS;
const nearPerM = (y) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(4);

/** How much of the ask a buyer agent plans to pay, by grade tier. */
export const PLAN_BPS = { A: 9000, B: 8000, C: 6000 };

async function llmNote(facts, fallback) {
  const key = process.env.TS_AGENT_KEY;
  if (!key) return fallback;
  try {
    const r = await fetch("https://cloud-api.near.ai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.TS_AGENT_MODEL || "z-ai/glm-5.3-flash",
        max_tokens: 1200,
        temperature: 0.2,
        messages: [
          { role: "system", content: "You write one short, polite negotiation note (max 200 characters) for an AI inference credit trade. State the reason using only the facts given. No prices other than those given. No quotes, no emoji." },
          { role: "user", content: JSON.stringify(facts) },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const j = await r.json();
    const t = String(j.choices?.[0]?.message?.content || "").replace(/\s+/g, " ").trim();
    return t && t.length <= 280 ? t : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Buyer agent: opens below its plan, accepts a counter within plan, counters
 * once at its plan with its reasoning, then accepts or walks away.
 */
export class BuyerAgent {
  constructor(buyer, { log = console.log } = {}) {
    this.buyer = buyer; // Buyer client
    this.log = log;
  }

  plan(listing) {
    const bps = PLAN_BPS[listing.grade?.tier];
    if (!bps) return null;
    return { in: scale(listing.ask_in, bps), out: scale(listing.ask_out, bps), bps };
  }

  async open(listing, depositYocto) {
    const plan = this.plan(listing);
    if (!plan) throw new Error(`no plan for tier ${listing.grade?.tier}: the agent does not buy ungraded or F listings`);
    this.plans = this.plans || {};
    const opening = { in: scale(plan.in, 8000), out: scale(plan.out, 8000) };
    const fallback = `Tier ${listing.grade.tier} listing. My plan is ${nearPerM(plan.out)} NEAR per 1M output; opening at ${nearPerM(opening.out)} for a ${Number(BigInt(depositYocto) / 10n ** 21n) / 1000} NEAR budget.`;
    const note = await llmNote({ role: "buyer", tier: listing.grade.tier, model: listing.model, ask_out: nearPerM(listing.ask_out), offer_out: nearPerM(opening.out), budget_near: Number(BigInt(depositYocto) / 10n ** 21n) / 1000 }, fallback);
    const r = await this.buyer.makeOffer(listing.id, opening.in, opening.out, note, depositYocto);
    this.plans[r.value] = plan;
    this.log(`  buyer ${this.buyer.accountId} offers ${nearPerM(opening.in)}/${nearPerM(opening.out)} on listing ${listing.id}: "${note}" tx ${r.txHash}`);
    return { offerId: r.value, tx: r.txHash, plan };
  }

  /** Reacts to the seller's last move. Returns "accepted" | "countered" | "walked" | "wait". */
  async react(offerId) {
    const o = await view("get_offer", { offer_id: String(offerId) });
    if (o.status !== "Open") return o.status.toLowerCase();
    const last = o.moves[o.moves.length - 1];
    if (last.by !== "Seller") return "wait";
    const plan = this.plans[offerId];
    const within = BigInt(last.price_in) <= plan.in && BigInt(last.price_out) <= plan.out;
    if (within) {
      const r = await call(this.buyer.accountId, "accept_offer", { offer_id: String(offerId) });
      this.buyer.bindOffer(offerId, r.value);
      this.log(`  buyer accepts ${nearPerM(last.price_in)}/${nearPerM(last.price_out)} -> order ${r.value} tx ${r.txHash}`);
      return { result: "accepted", orderId: r.value, tx: r.txHash };
    }
    const myCounters = o.moves.filter((m) => m.by === "Buyer").length - 1;
    if (myCounters >= 1 || o.moves.length >= 4) {
      const r = await call(this.buyer.accountId, "end_offer", { offer_id: String(offerId) });
      this.log(`  buyer walks away (counter above plan, no counters left) tx ${r.txHash}`);
      return { result: "walked", tx: r.txHash };
    }
    const fallback = `Your ${nearPerM(last.price_out)} is above my plan. I can pay ${nearPerM(plan.out)} per 1M output, ${plan.bps / 100}% of ask, for this tier. Final from me.`;
    const note = await llmNote({ role: "buyer", their_out: nearPerM(last.price_out), my_final_out: nearPerM(plan.out), reason: "tier-based plan" }, fallback);
    const r = await call(this.buyer.accountId, "counter_offer", { offer_id: String(offerId), price_in: String(plan.in), price_out: String(plan.out), note });
    this.log(`  buyer counters once at plan ${nearPerM(plan.in)}/${nearPerM(plan.out)}: "${note}" tx ${r.txHash}`);
    return { result: "countered", tx: r.txHash };
  }
}

/**
 * Seller agent: keeps a private floor (a share of its ask). Accepts at or
 * above the floor, otherwise counters halfway between the bid and the ask,
 * never below the floor, and rejects bids under half the floor.
 */
export class SellerAgent {
  constructor(sellerId, { floorBps = 8500, log = console.log } = {}) {
    this.sellerId = sellerId;
    this.floorBps = floorBps;
    this.log = log;
  }

  async react(offerId) {
    const o = await view("get_offer", { offer_id: String(offerId) });
    if (o.status !== "Open") return { result: o.status.toLowerCase() };
    const last = o.moves[o.moves.length - 1];
    if (last.by !== "Buyer") return { result: "wait" };
    const l = await view("get_listing", { listing_id: o.listing_id });
    const floor = { in: scale(l.ask_in, this.floorBps), out: scale(l.ask_out, this.floorBps) };
    const bid = { in: BigInt(last.price_in), out: BigInt(last.price_out) };
    if (bid.in >= floor.in && bid.out >= floor.out) {
      const r = await call(this.sellerId, "accept_offer", { offer_id: String(offerId) });
      this.log(`  seller ${this.sellerId} accepts ${nearPerM(bid.in)}/${nearPerM(bid.out)} -> order ${r.value} tx ${r.txHash}`);
      return { result: "accepted", orderId: r.value, tx: r.txHash };
    }
    if (bid.out * 2n < floor.out || o.moves.length >= 4) {
      const r = await call(this.sellerId, "end_offer", { offer_id: String(offerId) });
      this.log(`  seller rejects the bid tx ${r.txHash}`);
      return { result: "rejected", tx: r.txHash };
    }
    const mid = (a, b) => (a + b) / 2n;
    const max = (a, b) => (a > b ? a : b);
    // Concede toward the bid from the seller's own last price, never back up.
    const prev = [...o.moves].reverse().find((m) => m.by === "Seller");
    const ref = { in: BigInt(prev?.price_in ?? l.ask_in), out: BigInt(prev?.price_out ?? l.ask_out) };
    const counter = { in: max(floor.in, mid(bid.in, ref.in)), out: max(floor.out, mid(bid.out, ref.out)) };
    const fallback = `Graded ${l.grade?.tier} (${l.grade?.attested ? "TEE-attested" : "not attested"}), p50 ${l.grade?.p50_latency_ms} ms. I can meet you at ${nearPerM(counter.out)} per 1M output.`;
    const note = await llmNote({ role: "seller", tier: l.grade?.tier, attested: l.grade?.attested, p50_ms: l.grade?.p50_latency_ms, their_out: nearPerM(bid.out), counter_out: nearPerM(counter.out) }, fallback);
    const r = await call(this.sellerId, "counter_offer", { offer_id: String(offerId), price_in: String(counter.in), price_out: String(counter.out), note });
    this.log(`  seller counters ${nearPerM(counter.in)}/${nearPerM(counter.out)}: "${note}" tx ${r.txHash}`);
    return { result: "countered", tx: r.txHash };
  }
}

/**
 * Spot pricing rule for a seller: raise the ask when recent fills use up
 * capacity faster than the target, lower it when idle. Bounded per step.
 */
export function nextAsk(ask, { fills, targetFills, stepBps = 1000 }) {
  const a = BigInt(ask);
  if (fills > targetFills) return a + scale(a, stepBps);
  if (fills < targetFills) return a - scale(a, stepBps / 2);
  return a;
}

#!/usr/bin/env node
// Settles everything that can be settled and returns seller bonds:
// finalizes claims past the challenge window, settles closing orders, and
// closes idle listings owned by this deployment's seller accounts.
// Open orders are left alone (only their buyer can close them).
const { view, call, fmtNear } = await import("../node/src/near.js");
const P = process.env.P;
if (!P || !process.env.TS_CONTRACT) throw new Error("set P and TS_CONTRACT");
const signer = `grader.${P}`;
// Run twice if orders were just closed: the seller's claim window must pass first.
const cfg = await view("get_config");
const now = BigInt(Date.now()) * 1_000_000n;
const win = BigInt(cfg.challenge_window_sec) * 1_000_000_000n;

for (const c of await view("get_claims", { from: 0, limit: 100 })) {
  if (c.status === "Pending" && BigInt(c.submitted_at) + win <= now) {
    const r = await call(signer, "finalize_claim", { claim_id: c.id });
    const after = await view("get_claim", { claim_id: c.id });
    console.log(`claim ${c.id}: ${after.status} (${fmtNear(c.amount, 9)} NEAR) tx ${r.txHash}`);
  }
}
// Open orders held by this deployment's demo buyers are closed by their buyer.
for (const o of await view("get_orders", { from: 0, limit: 100 })) {
  if (o.status === "Open" && o.buyer.endsWith("." + P)) {
    const r = await call(o.buyer, "close_order", { order_id: o.id }).catch((e) => ({ error: e.message }));
    console.log(`order ${o.id}: ${r.txHash ? "closing (buyer " + o.buyer + ") tx " + r.txHash : r.error}`);
  }
}
for (const o of await view("get_orders", { from: 0, limit: 100 })) {
  if (o.status === "Closing" && o.pending === "0") {
    const r = await call(signer, "settle_close", { order_id: o.id }).catch((e) => ({ error: e.message }));
    console.log(`order ${o.id}: ${r.txHash ? "closed tx " + r.txHash : r.error}`);
  }
}
for (const l of await view("get_listings", { from: 0, limit: 100 })) {
  if (l.status !== "Closed" && l.open_orders === 0 && l.open_offers === 0 && l.seller.endsWith("." + P)) {
    const r = await call(l.seller, "close_listing", { listing_id: l.id }).catch((e) => ({ error: e.message }));
    console.log(`listing ${l.id}: ${r.txHash ? "closed, bond returned tx " + r.txHash : r.error}`);
  }
}

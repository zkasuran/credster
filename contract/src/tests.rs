use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const KEY: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(who: &str, deposit: u128, ts_sec: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("market.testnet"))
        .predecessor_account_id(acc(who))
        .signer_account_id(acc(who))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(ts_sec * SEC)
        .account_balance(NearToken::from_near(100));
    testing_env!(b.build());
}

fn market() -> Market {
    ctx("owner", 0, 1000);
    Market::new(acc("grader"), U128(NEAR), U128(NEAR / 100), 60, 3600, U128(NEAR / 10))
}

/// ask: 2 NEAR per 1M input, 8 NEAR per 1M output tokens.
fn listed(m: &mut Market) -> U64 {
    ctx("seller", NEAR, 1000);
    m.create_listing("Qwen/Qwen3.8-27B".into(), "https://seller.example/v1".into(), KEY.into(), U128(2 * NEAR), U128(8 * NEAR), U64(10_000_000))
}

fn grade(m: &mut Market, id: U64, tier: Tier, ts: u64) {
    ctx("grader", 0, ts);
    let pass = tier != Tier::F;
    m.post_grade(id, tier, if pass { 90 } else { 10 }, pass, pass, tier == Tier::A, 80, 900, 0, "a".repeat(64), "https://r".into());
}

#[test]
#[should_panic(expected = "listing not graded: only a trial order up to trial_cap")]
fn ungraded_listing_only_takes_trial_orders() {
    let mut m = market();
    let id = listed(&mut m);
    assert!(!m.is_tradable(id));
    ctx("grader-shopper", NEAR / 10, 1001);
    let oid = m.buy_spot(id, KEY.into());
    assert!(m.get_order(oid).unwrap().trial);
    ctx("buyer", NEAR, 1001);
    m.buy_spot(id, KEY.into());
}

#[test]
#[should_panic(expected = "listing not graded")]
fn ungraded_listing_refuses_offers() {
    let mut m = market();
    let id = listed(&mut m);
    ctx("buyer", NEAR / 10, 1001);
    m.make_offer(id, U128(1), U128(1), KEY.into(), "".into(), 60);
}

#[test]
fn new_endpoint_after_f_needs_a_new_grade() {
    let mut m = market();
    let id = listed(&mut m);
    grade(&mut m, id, Tier::F, 1001);
    ctx("seller", 0, 1002);
    m.update_endpoint(id, "https://fixed.example/v1".into(), KEY.into());
    let l = m.get_listing(id).unwrap();
    assert_eq!((l.status, l.f_grades, l.grade.is_none()), (ListingStatus::Active, 1, true));
    assert!(!m.is_tradable(id));
}

#[test]
#[should_panic(expected = "listing graded F")]
fn f_grade_suspends_and_blocks_buying() {
    let mut m = market();
    let id = listed(&mut m);
    grade(&mut m, id, Tier::F, 1001);
    assert_eq!(m.get_listing(id).unwrap().status, ListingStatus::Suspended);
    ctx("buyer", NEAR, 1002);
    m.buy_spot(id, KEY.into());
}

#[test]
#[should_panic(expected = "grade is stale")]
fn stale_grade_blocks_buying() {
    let mut m = market();
    let id = listed(&mut m);
    grade(&mut m, id, Tier::B, 1001);
    ctx("buyer", NEAR, 1001 + 3601);
    m.buy_spot(id, KEY.into());
}

#[test]
#[should_panic(expected = "a passing tier needs fingerprint_ok and metering_ok")]
fn grader_cannot_pass_a_failed_fingerprint() {
    let mut m = market();
    let id = listed(&mut m);
    ctx("grader", 0, 1001);
    m.post_grade(id, Tier::B, 70, false, true, false, 80, 900, 0, "a".repeat(64), "u".into());
}

#[test]
#[should_panic(expected = "tier A needs attested answers")]
fn tier_a_requires_attestation() {
    let mut m = market();
    let id = listed(&mut m);
    ctx("grader", 0, 1001);
    m.post_grade(id, Tier::A, 99, true, true, false, 80, 900, 0, "a".repeat(64), "u".into());
}

#[test]
fn passing_grade_lifts_suspension() {
    let mut m = market();
    let id = listed(&mut m);
    grade(&mut m, id, Tier::F, 1001);
    grade(&mut m, id, Tier::B, 1002);
    assert_eq!(m.get_listing(id).unwrap().status, ListingStatus::Active);
    assert!(m.is_tradable(id));
}

#[test]
fn spot_claim_finalize_close_refund() {
    let mut m = market();
    let id = listed(&mut m);
    grade(&mut m, id, Tier::B, 1001);
    ctx("buyer", NEAR, 1002);
    let oid = m.buy_spot(id, KEY.into());
    // Seller reprices after the fill; the spot order keeps the old price.
    ctx("seller", 0, 1003);
    m.update_ask(id, U128(4 * NEAR), U128(16 * NEAR));
    // 10k in, 5k out at (2, 8) per 1M = 0.02 + 0.04 = 0.06 NEAR
    let cid = m.submit_claim(oid, U64(10_000), U64(5_000), 3, "b".repeat(64));
    assert_eq!(m.get_claim(cid).unwrap().amount.0, 6 * NEAR / 100);
    assert_eq!(m.get_order(oid).unwrap().pending.0, 6 * NEAR / 100);
    ctx("anyone", 0, 1003 + 59);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| m.finalize_claim(cid))).is_err());
    ctx("anyone", 0, 1003 + 60);
    m.finalize_claim(cid);
    let o = m.get_order(oid).unwrap();
    assert_eq!(o.spent.0, 6 * NEAR / 100);
    assert_eq!(o.pending.0, 0);
    assert_eq!(m.get_listing(id).unwrap().capacity_tokens.0, 10_000_000 - 15_000);
    assert_eq!(m.get_stats().volume_paid.0, 6 * NEAR / 100);
    ctx("buyer", 0, 1100);
    m.close_order(oid);
    ctx("anyone", 0, 1100 + 60);
    m.settle_close(oid);
    let o = m.get_order(oid).unwrap();
    assert_eq!(o.status, OrderStatus::Closed);
    assert!(get_logs().iter().any(|l| l.contains("order_closed") && l.contains(&(NEAR - 6 * NEAR / 100).to_string())));
    assert_eq!(m.get_listing(id).unwrap().open_orders, 0);
}

#[test]
#[should_panic(expected = "claim exceeds remaining budget")]
fn claim_cannot_exceed_budget() {
    let mut m = market();
    let id = listed(&mut m);
    grade(&mut m, id, Tier::B, 1001);
    ctx("buyer", NEAR / 10, 1002);
    let oid = m.buy_spot(id, KEY.into());
    ctx("seller", 0, 1003);
    // 1M output tokens at 8 NEAR > 0.1 NEAR budget
    m.submit_claim(oid, U64(0), U64(1_000_000), 1, "b".repeat(64));
}

#[test]
#[should_panic(expected = "only seller")]
fn only_the_seller_claims() {
    let mut m = market();
    let id = listed(&mut m);
    grade(&mut m, id, Tier::B, 1001);
    ctx("buyer", NEAR, 1002);
    let oid = m.buy_spot(id, KEY.into());
    ctx("buyer", 0, 1003);
    m.submit_claim(oid, U64(1), U64(1), 1, "b".repeat(64));
}

#[test]
fn on_demand_tab_tracks_ask_under_ceiling() {
    let mut m = market();
    let id = listed(&mut m);
    grade(&mut m, id, Tier::B, 1001);
    ctx("buyer", NEAR, 1002);
    let oid = m.open_tab(id, U128(3 * NEAR), U128(10 * NEAR), KEY.into());
    ctx("seller", 0, 1003);
    let c1 = m.submit_claim(oid, U64(100_000), U64(0), 1, "b".repeat(64));
    assert_eq!(m.get_claim(c1).unwrap().price_in.0, 2 * NEAR, "ask below ceiling: pay the ask");
    m.update_ask(id, U128(5 * NEAR), U128(20 * NEAR));
    let c2 = m.submit_claim(oid, U64(0), U64(10_000), 1, "b".repeat(64));
    let c = m.get_claim(c2).unwrap();
    assert_eq!(c.price_out.0, 10 * NEAR, "ask above ceiling: pay the ceiling");
    assert_eq!(c.amount.0, NEAR / 10);
}

#[test]
fn bargain_counter_accept_creates_order_at_last_price() {
    let mut m = market();
    let id = listed(&mut m);
    grade(&mut m, id, Tier::B, 1001);
    ctx("buyer", NEAR, 1002);
    let off = m.make_offer(id, U128(NEAR), U128(4 * NEAR), KEY.into(), "50% of ask, I buy 100k tokens a day".into(), 600);
    assert_eq!(m.get_listing(id).unwrap().open_offers, 1);
    // buyer cannot move twice
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("buyer", 0, 1003);
        m.counter_offer(off, U128(NEAR), U128(5 * NEAR), "x".into());
    }))
    .is_err());
    ctx("seller", 0, 1004);
    m.counter_offer(off, U128(18 * NEAR / 10), U128(7 * NEAR), "floor is 1.6/6.5".into());
    ctx("buyer", 0, 1005);
    let oid = m.accept_offer(off);
    let o = m.get_order(oid).unwrap();
    assert_eq!(o.kind, OrderKind::Negotiated);
    assert_eq!(o.price_in.0, 18 * NEAR / 10);
    assert_eq!(o.price_out.0, 7 * NEAR);
    assert_eq!(o.deposit.0, NEAR);
    assert_eq!(m.get_offer(off).unwrap().status, OfferStatus::Accepted);
    let l = m.get_listing(id).unwrap();
    assert_eq!((l.open_offers, l.open_orders), (0, 1));
}

#[test]
#[should_panic(expected = "no rounds left")]
fn bargaining_is_bounded() {
    let mut m = market();
    let id = listed(&mut m);
    grade(&mut m, id, Tier::B, 1001);
    ctx("buyer", NEAR, 1002);
    let off = m.make_offer(id, U128(NEAR), U128(NEAR), KEY.into(), "".into(), 600);
    for (i, who) in ["seller", "buyer", "seller", "buyer"].iter().enumerate() {
        ctx(who, 0, 1003 + i as u64);
        m.counter_offer(off, U128(NEAR), U128(NEAR), "".into());
    }
}

#[test]
fn rejected_and_expired_offers_refund() {
    let mut m = market();
    let id = listed(&mut m);
    grade(&mut m, id, Tier::B, 1001);
    ctx("buyer", NEAR, 1002);
    let a = m.make_offer(id, U128(1), U128(1), KEY.into(), "lowball".into(), 600);
    ctx("seller", 0, 1003);
    m.end_offer(a);
    assert_eq!(m.get_offer(a).unwrap().status, OfferStatus::Rejected);
    ctx("buyer", NEAR, 1004);
    let b = m.make_offer(id, U128(1), U128(1), KEY.into(), "".into(), 10);
    ctx("stranger", 0, 1004 + 11);
    m.end_offer(b);
    assert_eq!(m.get_offer(b).unwrap().status, OfferStatus::Expired);
    assert_eq!(m.get_listing(id).unwrap().open_offers, 0);
}

#[test]
fn rejected_dispute_slashes_bond_to_buyer() {
    let mut m = market();
    let id = listed(&mut m);
    grade(&mut m, id, Tier::B, 1001);
    ctx("buyer", NEAR, 1002);
    let oid = m.buy_spot(id, KEY.into());
    ctx("seller", 0, 1003);
    let cid = m.submit_claim(oid, U64(100_000), U64(0), 2, "b".repeat(64));
    ctx("buyer", 0, 1010);
    m.dispute_claim(cid, "claimed 100000 input tokens, my receipts sum to 1200".into());
    ctx("anyone", 0, 1100);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| m.finalize_claim(cid))).is_err(), "disputed claim cannot be finalized");
    ctx("grader", 0, 1101);
    m.resolve_dispute(cid, false, U128(NEAR / 2), "receipts do not cover the claim".into());
    let c = m.get_claim(cid).unwrap();
    assert_eq!(c.status, ClaimStatus::Rejected);
    assert_eq!(c.slashed.0, NEAR / 2);
    assert_eq!(m.get_listing(id).unwrap().bond.0, NEAR / 2);
    assert_eq!(m.get_order(oid).unwrap().pending.0, 0);
    assert_eq!(m.get_order(oid).unwrap().spent.0, 0);
    assert_eq!(m.get_stats().slashed_total.0, NEAR / 2);
}

#[test]
fn upheld_dispute_pays_seller() {
    let mut m = market();
    let id = listed(&mut m);
    grade(&mut m, id, Tier::B, 1001);
    ctx("buyer", NEAR, 1002);
    let oid = m.buy_spot(id, KEY.into());
    ctx("seller", 0, 1003);
    let cid = m.submit_claim(oid, U64(100_000), U64(0), 2, "b".repeat(64));
    ctx("buyer", 0, 1004);
    m.dispute_claim(cid, "too high".into());
    ctx("grader", 0, 1005);
    m.resolve_dispute(cid, true, U128(0), "receipts match".into());
    assert_eq!(m.get_claim(cid).unwrap().status, ClaimStatus::Paid);
    assert_eq!(m.get_order(oid).unwrap().spent.0, NEAR / 5);
}

#[test]
#[should_panic(expected = "challenge window over")]
fn dispute_after_window_is_refused() {
    let mut m = market();
    let id = listed(&mut m);
    grade(&mut m, id, Tier::B, 1001);
    ctx("buyer", NEAR, 1002);
    let oid = m.buy_spot(id, KEY.into());
    ctx("seller", 0, 1003);
    let cid = m.submit_claim(oid, U64(1), U64(1), 1, "b".repeat(64));
    ctx("buyer", 0, 1003 + 60);
    m.dispute_claim(cid, "late".into());
}

#[test]
#[should_panic(expected = "claims still pending")]
fn close_waits_for_pending_claims() {
    let mut m = market();
    let id = listed(&mut m);
    grade(&mut m, id, Tier::B, 1001);
    ctx("buyer", NEAR, 1002);
    let oid = m.buy_spot(id, KEY.into());
    ctx("buyer", 0, 1003);
    m.close_order(oid);
    ctx("seller", 0, 1004);
    m.submit_claim(oid, U64(1), U64(1), 1, "b".repeat(64));
    ctx("anyone", 0, 1003 + 61);
    m.settle_close(oid);
}

#[test]
fn suspended_listing_lets_buyer_leave_at_once() {
    let mut m = market();
    let id = listed(&mut m);
    grade(&mut m, id, Tier::B, 1001);
    ctx("buyer", NEAR, 1002);
    let oid = m.buy_spot(id, KEY.into());
    grade(&mut m, id, Tier::F, 1003);
    ctx("buyer", 0, 1004);
    m.close_order(oid);
    ctx("buyer", 0, 1005);
    m.settle_close(oid);
    assert_eq!(m.get_order(oid).unwrap().status, OrderStatus::Closed);
}

#[test]
fn close_listing_returns_bond_only_when_idle() {
    let mut m = market();
    let id = listed(&mut m);
    grade(&mut m, id, Tier::B, 1001);
    ctx("buyer", NEAR, 1002);
    let oid = m.buy_spot(id, KEY.into());
    ctx("seller", 0, 1003);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| m.close_listing(id))).is_err());
    ctx("buyer", 0, 1004);
    m.close_order(oid);
    ctx("anyone", 0, 1004 + 60);
    m.settle_close(oid);
    ctx("seller", 0, 1100);
    m.close_listing(id);
    let l = m.get_listing(id).unwrap();
    assert_eq!((l.status, l.bond.0), (ListingStatus::Closed, 0));
}

#[test]
fn cost_rounds_up_by_at_most_one_yocto() {
    assert_eq!(cost(1, 0, 1, 0), 1);
    assert_eq!(cost(1_000_000, 0, 7, 0), 7);
    assert_eq!(cost(1_000_001, 0, 1_000_000, 0), 1_000_001);
}

#[test]
fn probe_usage_on_an_f_listing_is_not_paid() {
    let mut m = market();
    let id = listed(&mut m);
    ctx("grader", NEAR / 20, 1001);
    let oid = m.buy_spot(id, KEY.into());
    // The seller claims before the grade lands...
    ctx("seller", 0, 1002);
    let early = m.submit_claim(oid, U64(1000), U64(1000), 2, "b".repeat(64));
    grade(&mut m, id, Tier::F, 1003);
    // ...and cannot claim after it.
    ctx("seller", 0, 1004);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| m.submit_claim(oid, U64(1), U64(1), 1, "b".repeat(64)))).is_err());
    ctx("anyone", 0, 1002 + 60);
    m.finalize_claim(early);
    assert_eq!(m.get_claim(early).unwrap().status, ClaimStatus::Rejected);
    assert_eq!(m.get_order(oid).unwrap().spent.0, 0);
    assert_eq!(m.get_order(oid).unwrap().pending.0, 0);
    assert_eq!(m.get_stats().volume_paid.0, 0);
}

#[test]
fn customer_usage_before_an_f_grade_is_still_paid() {
    let mut m = market();
    let id = listed(&mut m);
    grade(&mut m, id, Tier::B, 1001);
    ctx("buyer", NEAR, 1002);
    let oid = m.buy_spot(id, KEY.into());
    ctx("seller", 0, 1003);
    let c = m.submit_claim(oid, U64(1000), U64(0), 1, "b".repeat(64));
    grade(&mut m, id, Tier::F, 1004);
    ctx("anyone", 0, 1003 + 60);
    m.finalize_claim(c);
    assert_eq!(m.get_claim(c).unwrap().status, ClaimStatus::Paid);
}

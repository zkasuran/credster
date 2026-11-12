//! Credster market: AI inference credits sold by graded sellers.
//!
//! Sellers list an OpenAI-compatible endpoint for one model and post a bond.
//! A grader account posts a grade for each listing after probing the endpoint.
//! Only listings with a fresh grade that is not F can trade.
//!
//! Three ways to buy:
//! * Spot: pay a deposit now, price locked at the seller's current ask.
//! * Bargain: offer, counter and accept (at most `MAX_ROUNDS` moves), then a
//!   negotiated order at the agreed price.
//! * On-demand tab: a deposit with a price ceiling. Each usage claim is priced
//!   at the seller's ask when the claim is made, never above the ceiling.
//!
//! Usage is settled optimistically: the seller claims tokens it served (backed
//! by receipts its node signed), the buyer has `challenge_window` to dispute,
//! and the grader resolves disputes. A rejected claim can slash the seller's
//! bond to the buyer. All money is native NEAR in yoctoNEAR.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};

pub const MAX_ROUNDS: u8 = 4;
pub const MAX_NOTE: usize = 280;
pub const MAX_TEXT: usize = 200;
const TOKENS_PER_PRICE_UNIT: u128 = 1_000_000;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Listings,
    Offers,
    Orders,
    Claims,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    A,
    B,
    C,
    F,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Grade {
    pub tier: Tier,
    /// 0..=100
    pub score: u8,
    /// Reported prompt token counts match the claimed model's tokenizer.
    pub fingerprint_ok: bool,
    /// Reported usage is not inflated relative to the reference.
    pub metering_ok: bool,
    /// Answers were signed by an attested TEE key for the claimed model.
    pub attested: bool,
    /// Share of randomized checkable tasks answered correctly, 0..=100.
    pub capability_pct: u8,
    pub p50_latency_ms: u32,
    pub error_pct: u8,
    /// sha256 hex of the full JSON grade report.
    pub report_hash: String,
    pub report_url: String,
    pub graded_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListingStatus {
    Active,
    Paused,
    /// Set by an F grade. Cannot trade until a passing grade.
    Suspended,
    Closed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Listing {
    pub id: U64,
    pub seller: AccountId,
    pub model: String,
    pub endpoint: String,
    /// ed25519 public key ("ed25519:<base58>") the seller node signs receipts with.
    pub node_key: String,
    /// Ask in yoctoNEAR per 1M input / output tokens.
    pub ask_in: U128,
    pub ask_out: U128,
    /// Tokens the seller still offers. Decremented when claims are paid.
    pub capacity_tokens: U64,
    pub bond: U128,
    pub status: ListingStatus,
    pub grade: Option<Grade>,
    pub open_orders: u32,
    pub open_offers: u32,
    pub tokens_sold: U64,
    pub f_grades: u32,
    pub created_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Party {
    Buyer,
    Seller,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Move {
    pub by: Party,
    pub price_in: U128,
    pub price_out: U128,
    pub note: String,
    pub at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OfferStatus {
    Open,
    Accepted,
    Rejected,
    Withdrawn,
    Expired,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Offer {
    pub id: U64,
    pub listing_id: U64,
    pub buyer: AccountId,
    pub buyer_key: String,
    pub deposit: U128,
    pub moves: Vec<Move>,
    pub status: OfferStatus,
    pub expires_at: U64,
    pub order_id: Option<U64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderKind {
    Spot,
    Negotiated,
    OnDemand,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderStatus {
    Open,
    Closing,
    Closed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Order {
    pub id: U64,
    pub listing_id: U64,
    pub buyer: AccountId,
    /// ed25519 key the buyer signs gateway requests with.
    pub buyer_key: String,
    pub kind: OrderKind,
    /// A small spot order on an ungraded or stale listing. Graders buy these
    /// like any buyer, so a seller cannot tell a probe from a customer.
    pub trial: bool,
    /// Locked price (Spot, Negotiated) or ceiling (OnDemand), yocto per 1M tokens.
    pub price_in: U128,
    pub price_out: U128,
    pub deposit: U128,
    pub spent: U128,
    pub pending: U128,
    pub status: OrderStatus,
    pub opened_at: U64,
    pub close_requested_at: Option<U64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimStatus {
    Pending,
    Disputed,
    Paid,
    Rejected,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Claim {
    pub id: U64,
    pub order_id: U64,
    pub in_tokens: U64,
    pub out_tokens: U64,
    pub amount: U128,
    /// Unit prices used for this claim.
    pub price_in: U128,
    pub price_out: U128,
    pub receipts: u32,
    /// sha256 hex over the receipts the seller node signed for this claim.
    pub receipts_hash: String,
    pub status: ClaimStatus,
    pub submitted_at: U64,
    pub dispute_reason: Option<String>,
    pub resolution: Option<String>,
    pub slashed: U128,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub grader: AccountId,
    pub min_bond: U128,
    pub min_deposit: U128,
    pub challenge_window_sec: u64,
    pub max_grade_age_sec: u64,
    pub offer_ttl_max_sec: u64,
    pub trial_cap: U128,
}

#[near(serializers = [json])]
pub struct Stats {
    pub listings: u64,
    pub offers: u64,
    pub orders: u64,
    pub claims: u64,
    pub volume_paid: U128,
    pub slashed_total: U128,
    pub tokens_settled: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Market {
    owner: AccountId,
    grader: AccountId,
    min_bond: u128,
    min_deposit: u128,
    challenge_window_ns: u64,
    max_grade_age_ns: u64,
    offer_ttl_max_ns: u64,
    /// Largest deposit for a trial order on an ungraded or stale listing.
    trial_cap: u128,
    listings: IterableMap<u64, Listing>,
    offers: IterableMap<u64, Offer>,
    orders: IterableMap<u64, Order>,
    claims: IterableMap<u64, Claim>,
    next_listing: u64,
    next_offer: u64,
    next_order: u64,
    next_claim: u64,
    volume_paid: u128,
    slashed_total: u128,
    tokens_settled: u64,
}

const SEC: u64 = 1_000_000_000;

fn cost(in_tokens: u64, out_tokens: u64, price_in: u128, price_out: u128) -> u128 {
    // Round up so a seller is never paid less than the tokens it served at
    // the agreed price, and the buyer never pays more than one yocto extra.
    let num = (in_tokens as u128) * price_in + (out_tokens as u128) * price_out;
    num.div_ceil(TOKENS_PER_PRICE_UNIT)
}

fn check_key(key: &str) {
    require!(
        key.starts_with("ed25519:") && key.len() > 40 && key.len() < 70,
        "key must be ed25519:<base58>"
    );
}

fn check_text(s: &str, max: usize, what: &str) {
    require!(s.len() <= max, format!("{what} too long"));
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let body = near_sdk::serde_json::json!({
        "standard": "credster",
        "version": "1.0.0",
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{body}"));
}

fn transfer(to: &AccountId, amount: u128) {
    if amount > 0 {
        Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount)).detach();
    }
}

#[near]
impl Market {
    #[init]
    pub fn new(
        grader: AccountId,
        min_bond: U128,
        min_deposit: U128,
        challenge_window_sec: u64,
        max_grade_age_sec: u64,
        trial_cap: U128,
    ) -> Self {
        Self {
            owner: env::predecessor_account_id(),
            grader,
            min_bond: min_bond.0,
            min_deposit: min_deposit.0,
            challenge_window_ns: challenge_window_sec * SEC,
            max_grade_age_ns: max_grade_age_sec * SEC,
            offer_ttl_max_ns: 7 * 24 * 3600 * SEC,
            trial_cap: trial_cap.0,
            listings: IterableMap::new(StorageKey::Listings),
            offers: IterableMap::new(StorageKey::Offers),
            orders: IterableMap::new(StorageKey::Orders),
            claims: IterableMap::new(StorageKey::Claims),
            next_listing: 0,
            next_offer: 0,
            next_order: 0,
            next_claim: 0,
            volume_paid: 0,
            slashed_total: 0,
            tokens_settled: 0,
        }
    }

    // ---------------------------------------------------------------- owner

    pub fn set_grader(&mut self, grader: AccountId) {
        self.only_owner();
        self.grader = grader;
    }

    pub fn set_params(&mut self, challenge_window_sec: u64, max_grade_age_sec: u64) {
        self.only_owner();
        self.challenge_window_ns = challenge_window_sec * SEC;
        self.max_grade_age_ns = max_grade_age_sec * SEC;
    }

    // --------------------------------------------------------------- seller

    #[payable]
    pub fn create_listing(
        &mut self,
        model: String,
        endpoint: String,
        node_key: String,
        ask_in: U128,
        ask_out: U128,
        capacity_tokens: U64,
    ) -> U64 {
        let bond = env::attached_deposit().as_yoctonear();
        require!(bond >= self.min_bond, "bond below min_bond");
        require!(!model.is_empty() && !endpoint.is_empty(), "model and endpoint required");
        check_text(&model, MAX_TEXT, "model");
        check_text(&endpoint, MAX_TEXT, "endpoint");
        require!(endpoint.starts_with("https://") || endpoint.starts_with("http://"), "endpoint must be http(s)");
        check_key(&node_key);
        require!(ask_in.0 > 0 && ask_out.0 > 0, "ask must be > 0");
        require!(capacity_tokens.0 > 0, "capacity must be > 0");
        let id = self.next_listing;
        self.next_listing += 1;
        let l = Listing {
            id: U64(id),
            seller: env::predecessor_account_id(),
            model,
            endpoint,
            node_key,
            ask_in,
            ask_out,
            capacity_tokens,
            bond: U128(bond),
            status: ListingStatus::Active,
            grade: None,
            open_orders: 0,
            open_offers: 0,
            tokens_sold: U64(0),
            f_grades: 0,
            created_at: U64(env::block_timestamp()),
        };
        emit("listing_created", near_sdk::serde_json::json!({"listing_id": U64(id), "seller": l.seller, "model": l.model, "ask_in": ask_in, "ask_out": ask_out}));
        self.listings.insert(id, l);
        U64(id)
    }

    /// The spot price moves: a seller (or its pricing agent) reprices at any time.
    /// Locked orders keep their price; on-demand tabs use the new ask, capped.
    pub fn update_ask(&mut self, listing_id: U64, ask_in: U128, ask_out: U128) {
        require!(ask_in.0 > 0 && ask_out.0 > 0, "ask must be > 0");
        let l = self.seller_listing(listing_id.0);
        l.ask_in = ask_in;
        l.ask_out = ask_out;
        emit("ask_updated", near_sdk::serde_json::json!({"listing_id": listing_id, "ask_in": ask_in, "ask_out": ask_out}));
    }

    pub fn update_capacity(&mut self, listing_id: U64, capacity_tokens: U64) {
        let l = self.seller_listing(listing_id.0);
        l.capacity_tokens = capacity_tokens;
    }

    pub fn update_endpoint(&mut self, listing_id: U64, endpoint: String, node_key: String) {
        check_text(&endpoint, MAX_TEXT, "endpoint");
        require!(endpoint.starts_with("https://") || endpoint.starts_with("http://"), "endpoint must be http(s)");
        check_key(&node_key);
        let l = self.seller_listing(listing_id.0);
        l.endpoint = endpoint;
        l.node_key = node_key;
        // A new endpoint is a different thing to grade. A suspended listing
        // can only take trial orders until it earns a passing grade.
        l.grade = None;
        if l.status == ListingStatus::Suspended {
            l.status = ListingStatus::Active;
        }
    }

    pub fn set_paused(&mut self, listing_id: U64, paused: bool) {
        let l = self.seller_listing(listing_id.0);
        require!(l.status == ListingStatus::Active || l.status == ListingStatus::Paused, "listing not active or paused");
        l.status = if paused { ListingStatus::Paused } else { ListingStatus::Active };
    }

    #[payable]
    pub fn top_up_bond(&mut self, listing_id: U64) {
        let add = env::attached_deposit().as_yoctonear();
        let l = self.seller_listing(listing_id.0);
        l.bond = U128(l.bond.0 + add);
    }

    /// Closes a listing with no open orders or offers and returns the bond.
    pub fn close_listing(&mut self, listing_id: U64) {
        let l = self.seller_listing(listing_id.0);
        require!(l.open_orders == 0 && l.open_offers == 0, "listing has open orders or offers");
        require!(l.status != ListingStatus::Closed, "already closed");
        let bond = l.bond.0;
        let seller = l.seller.clone();
        l.bond = U128(0);
        l.status = ListingStatus::Closed;
        transfer(&seller, bond);
        emit("listing_closed", near_sdk::serde_json::json!({"listing_id": listing_id}));
    }

    // --------------------------------------------------------------- grader

    #[allow(clippy::too_many_arguments)]
    pub fn post_grade(
        &mut self,
        listing_id: U64,
        tier: Tier,
        score: u8,
        fingerprint_ok: bool,
        metering_ok: bool,
        attested: bool,
        capability_pct: u8,
        p50_latency_ms: u32,
        error_pct: u8,
        report_hash: String,
        report_url: String,
    ) {
        self.only_grader();
        require!(score <= 100 && capability_pct <= 100 && error_pct <= 100, "percent out of range");
        require!(report_hash.len() == 64, "report_hash must be sha256 hex");
        check_text(&report_url, MAX_TEXT, "report_url");
        // A grade cannot say the model is right while its own fingerprint check failed.
        if tier != Tier::F {
            require!(fingerprint_ok && metering_ok, "a passing tier needs fingerprint_ok and metering_ok");
        }
        if tier == Tier::A {
            require!(attested, "tier A needs attested answers");
        }
        let l = self.listings.get_mut(&listing_id.0).unwrap_or_else(|| env::panic_str("no listing"));
        require!(l.status != ListingStatus::Closed, "listing closed");
        l.grade = Some(Grade {
            tier,
            score,
            fingerprint_ok,
            metering_ok,
            attested,
            capability_pct,
            p50_latency_ms,
            error_pct,
            report_hash: report_hash.clone(),
            report_url,
            graded_at: U64(env::block_timestamp()),
        });
        if tier == Tier::F {
            l.status = ListingStatus::Suspended;
            l.f_grades += 1;
        } else if l.status == ListingStatus::Suspended {
            l.status = ListingStatus::Active;
        }
        emit("graded", near_sdk::serde_json::json!({"listing_id": listing_id, "tier": tier, "score": score, "fingerprint_ok": fingerprint_ok, "metering_ok": metering_ok, "attested": attested, "report_hash": report_hash}));
    }

    /// Settles a disputed claim. `uphold` pays the seller. Otherwise the claim
    /// is rejected, and up to `slash` of the seller's bond goes to the buyer.
    pub fn resolve_dispute(&mut self, claim_id: U64, uphold: bool, slash: U128, resolution: String) {
        self.only_grader();
        check_text(&resolution, MAX_NOTE, "resolution");
        let c = self.claims.get(&claim_id.0).cloned().unwrap_or_else(|| env::panic_str("no claim"));
        require!(c.status == ClaimStatus::Disputed, "claim not disputed");
        if uphold {
            self.pay_claim(claim_id.0);
            let c = self.claims.get_mut(&claim_id.0).unwrap();
            c.resolution = Some(resolution);
            return;
        }
        let order = self.orders.get_mut(&c.order_id.0).unwrap();
        order.pending = U128(order.pending.0 - c.amount.0);
        let buyer = order.buyer.clone();
        let listing_id = order.listing_id.0;
        let l = self.listings.get_mut(&listing_id).unwrap();
        let slashed = slash.0.min(l.bond.0);
        l.bond = U128(l.bond.0 - slashed);
        self.slashed_total += slashed;
        let c = self.claims.get_mut(&claim_id.0).unwrap();
        c.status = ClaimStatus::Rejected;
        c.resolution = Some(resolution);
        c.slashed = U128(slashed);
        transfer(&buyer, slashed);
        emit("dispute_resolved", near_sdk::serde_json::json!({"claim_id": claim_id, "upheld": false, "slashed": U128(slashed)}));
    }

    // ---------------------------------------------------------------- buyer

    /// Buys at the seller's current ask. The deposit is the budget; unused
    /// budget comes back when the order is closed.
    #[payable]
    pub fn buy_spot(&mut self, listing_id: U64, buyer_key: String) -> U64 {
        let deposit = env::attached_deposit().as_yoctonear();
        let l = self.listings.get(&listing_id.0).unwrap_or_else(|| env::panic_str("no listing"));
        let trial = match self.tradable_reason(l) {
            None => false,
            Some(r @ ("listing not graded" | "grade is stale")) => {
                require!(deposit <= self.trial_cap, format!("{r}: only a trial order up to trial_cap"));
                true
            }
            Some(r) => env::panic_str(r),
        };
        let (pi, po) = (l.ask_in, l.ask_out);
        self.open_order(listing_id.0, env::predecessor_account_id(), buyer_key, OrderKind::Spot, pi, po, deposit, trial)
    }

    /// Opens a pay-as-you-go tab. Each claim is priced at the ask at claim
    /// time, capped at these ceilings.
    #[payable]
    pub fn open_tab(&mut self, listing_id: U64, ceiling_in: U128, ceiling_out: U128, buyer_key: String) -> U64 {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(ceiling_in.0 > 0 && ceiling_out.0 > 0, "ceiling must be > 0");
        self.tradable(listing_id.0);
        self.open_order(listing_id.0, env::predecessor_account_id(), buyer_key, OrderKind::OnDemand, ceiling_in, ceiling_out, deposit, false)
    }

    /// Opens a negotiation. The deposit is escrowed and becomes the order
    /// budget on acceptance, or is refunded otherwise.
    #[payable]
    pub fn make_offer(&mut self, listing_id: U64, price_in: U128, price_out: U128, buyer_key: String, note: String, ttl_sec: u64) -> U64 {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= self.min_deposit, "deposit below min_deposit");
        require!(price_in.0 > 0 && price_out.0 > 0, "price must be > 0");
        check_key(&buyer_key);
        check_text(&note, MAX_NOTE, "note");
        let ttl = (ttl_sec * SEC).min(self.offer_ttl_max_ns);
        require!(ttl > 0, "ttl must be > 0");
        let buyer = env::predecessor_account_id();
        {
            let l = self.tradable(listing_id.0);
            require!(l.seller != buyer, "seller cannot buy own listing");
        }
        self.listings.get_mut(&listing_id.0).unwrap().open_offers += 1;
        let id = self.next_offer;
        self.next_offer += 1;
        let now = env::block_timestamp();
        self.offers.insert(
            id,
            Offer {
                id: U64(id),
                listing_id,
                buyer: buyer.clone(),
                buyer_key,
                deposit: U128(deposit),
                moves: vec![Move { by: Party::Buyer, price_in, price_out, note, at: U64(now) }],
                status: OfferStatus::Open,
                expires_at: U64(now + ttl),
                order_id: None,
            },
        );
        emit("offer_made", near_sdk::serde_json::json!({"offer_id": U64(id), "listing_id": listing_id, "buyer": buyer, "price_in": price_in, "price_out": price_out}));
        U64(id)
    }

    /// The party that did not make the last move counters.
    pub fn counter_offer(&mut self, offer_id: U64, price_in: U128, price_out: U128, note: String) {
        require!(price_in.0 > 0 && price_out.0 > 0, "price must be > 0");
        check_text(&note, MAX_NOTE, "note");
        let party = self.party_to_move(offer_id.0);
        let o = self.offers.get_mut(&offer_id.0).unwrap();
        require!(o.moves.len() < MAX_ROUNDS as usize, "no rounds left: accept or walk away");
        o.moves.push(Move { by: party, price_in, price_out, note, at: U64(env::block_timestamp()) });
        emit("offer_countered", near_sdk::serde_json::json!({"offer_id": offer_id, "by": party, "price_in": price_in, "price_out": price_out, "round": o.moves.len()}));
    }

    /// The party that did not make the last move accepts the last price.
    pub fn accept_offer(&mut self, offer_id: U64) -> U64 {
        let _ = self.party_to_move(offer_id.0);
        let o = self.offers.get(&offer_id.0).cloned().unwrap();
        self.tradable(o.listing_id.0);
        let last = o.moves.last().unwrap().clone();
        self.listings.get_mut(&o.listing_id.0).unwrap().open_offers -= 1;
        let order_id = self.open_order(o.listing_id.0, o.buyer.clone(), o.buyer_key.clone(), OrderKind::Negotiated, last.price_in, last.price_out, o.deposit.0, false);
        let o = self.offers.get_mut(&offer_id.0).unwrap();
        o.status = OfferStatus::Accepted;
        o.order_id = Some(order_id);
        emit("offer_accepted", near_sdk::serde_json::json!({"offer_id": offer_id, "order_id": order_id, "price_in": last.price_in, "price_out": last.price_out}));
        order_id
    }

    /// Seller rejects, buyer withdraws, or anyone expires a stale offer.
    /// The buyer's deposit is refunded in every case.
    pub fn end_offer(&mut self, offer_id: U64) {
        let caller = env::predecessor_account_id();
        let o = self.offers.get(&offer_id.0).cloned().unwrap_or_else(|| env::panic_str("no offer"));
        require!(o.status == OfferStatus::Open, "offer not open");
        let seller = self.listings.get(&o.listing_id.0).unwrap().seller.clone();
        let status = if env::block_timestamp() > o.expires_at.0 {
            OfferStatus::Expired
        } else if caller == o.buyer {
            OfferStatus::Withdrawn
        } else if caller == seller {
            OfferStatus::Rejected
        } else {
            env::panic_str("only buyer or seller before expiry")
        };
        self.listings.get_mut(&o.listing_id.0).unwrap().open_offers -= 1;
        self.offers.get_mut(&offer_id.0).unwrap().status = status;
        transfer(&o.buyer, o.deposit.0);
        emit("offer_ended", near_sdk::serde_json::json!({"offer_id": offer_id, "status": status}));
    }

    #[payable]
    pub fn top_up_order(&mut self, order_id: U64) {
        let add = env::attached_deposit().as_yoctonear();
        let o = self.orders.get_mut(&order_id.0).unwrap_or_else(|| env::panic_str("no order"));
        require!(o.buyer == env::predecessor_account_id(), "only buyer");
        require!(o.status == OrderStatus::Open, "order not open");
        o.deposit = U128(o.deposit.0 + add);
    }

    pub fn set_order_key(&mut self, order_id: U64, buyer_key: String) {
        check_key(&buyer_key);
        let o = self.orders.get_mut(&order_id.0).unwrap_or_else(|| env::panic_str("no order"));
        require!(o.buyer == env::predecessor_account_id(), "only buyer");
        o.buyer_key = buyer_key;
    }

    /// Starts closing. The seller can still claim usage for one challenge
    /// window. Closing is immediate if the listing is suspended.
    pub fn close_order(&mut self, order_id: U64) {
        let o = self.orders.get_mut(&order_id.0).unwrap_or_else(|| env::panic_str("no order"));
        require!(o.buyer == env::predecessor_account_id(), "only buyer");
        require!(o.status == OrderStatus::Open, "order not open");
        o.status = OrderStatus::Closing;
        o.close_requested_at = Some(U64(env::block_timestamp()));
        emit("order_closing", near_sdk::serde_json::json!({"order_id": order_id}));
    }

    /// Anyone can finish a close after the window when no claim is pending.
    pub fn settle_close(&mut self, order_id: U64) {
        let o = self.orders.get(&order_id.0).cloned().unwrap_or_else(|| env::panic_str("no order"));
        require!(o.status == OrderStatus::Closing, "order not closing");
        require!(o.pending.0 == 0, "claims still pending");
        let suspended = self.listings.get(&o.listing_id.0).unwrap().status == ListingStatus::Suspended;
        if !suspended {
            require!(env::block_timestamp() >= o.close_requested_at.unwrap().0 + self.challenge_window_ns, "seller claim window still open");
        }
        let refund = o.deposit.0 - o.spent.0;
        let ord = self.orders.get_mut(&order_id.0).unwrap();
        ord.status = OrderStatus::Closed;
        self.listings.get_mut(&o.listing_id.0).unwrap().open_orders -= 1;
        transfer(&o.buyer, refund);
        emit("order_closed", near_sdk::serde_json::json!({"order_id": order_id, "refund": U128(refund), "spent": o.spent}));
    }

    pub fn dispute_claim(&mut self, claim_id: U64, reason: String) {
        check_text(&reason, MAX_NOTE, "reason");
        let c = self.claims.get(&claim_id.0).cloned().unwrap_or_else(|| env::panic_str("no claim"));
        require!(c.status == ClaimStatus::Pending, "claim not pending");
        require!(env::block_timestamp() < c.submitted_at.0 + self.challenge_window_ns, "challenge window over");
        let o = self.orders.get(&c.order_id.0).unwrap();
        require!(o.buyer == env::predecessor_account_id(), "only buyer");
        let c = self.claims.get_mut(&claim_id.0).unwrap();
        c.status = ClaimStatus::Disputed;
        c.dispute_reason = Some(reason.clone());
        emit("claim_disputed", near_sdk::serde_json::json!({"claim_id": claim_id, "reason": reason}));
    }

    // ------------------------------------------------------------ settlement

    /// The seller claims usage its node served and signed receipts for.
    pub fn submit_claim(&mut self, order_id: U64, in_tokens: U64, out_tokens: U64, receipts: u32, receipts_hash: String) -> U64 {
        require!(receipts_hash.len() == 64, "receipts_hash must be sha256 hex");
        require!(in_tokens.0 + out_tokens.0 > 0 && receipts > 0, "empty claim");
        let o = self.orders.get(&order_id.0).cloned().unwrap_or_else(|| env::panic_str("no order"));
        let l = self.listings.get(&o.listing_id.0).unwrap();
        require!(l.seller == env::predecessor_account_id(), "only seller");
        require!(!(o.trial && l.status == ListingStatus::Suspended), "probe usage on a listing graded F is not paid");
        match o.status {
            OrderStatus::Open => {}
            OrderStatus::Closing => require!(env::block_timestamp() < o.close_requested_at.unwrap().0 + self.challenge_window_ns, "close window over"),
            OrderStatus::Closed => env::panic_str("order closed"),
        }
        let (pi, po) = match o.kind {
            OrderKind::OnDemand => (l.ask_in.0.min(o.price_in.0), l.ask_out.0.min(o.price_out.0)),
            _ => (o.price_in.0, o.price_out.0),
        };
        let amount = cost(in_tokens.0, out_tokens.0, pi, po);
        require!(o.spent.0 + o.pending.0 + amount <= o.deposit.0, "claim exceeds remaining budget");
        let id = self.next_claim;
        self.next_claim += 1;
        self.claims.insert(
            id,
            Claim {
                id: U64(id),
                order_id,
                in_tokens,
                out_tokens,
                amount: U128(amount),
                price_in: U128(pi),
                price_out: U128(po),
                receipts,
                receipts_hash,
                status: ClaimStatus::Pending,
                submitted_at: U64(env::block_timestamp()),
                dispute_reason: None,
                resolution: None,
                slashed: U128(0),
            },
        );
        let ord = self.orders.get_mut(&order_id.0).unwrap();
        ord.pending = U128(ord.pending.0 + amount);
        emit("claim_submitted", near_sdk::serde_json::json!({"claim_id": U64(id), "order_id": order_id, "in_tokens": in_tokens, "out_tokens": out_tokens, "amount": U128(amount)}));
        U64(id)
    }

    /// Anyone pays out an undisputed claim after the challenge window.
    pub fn finalize_claim(&mut self, claim_id: U64) {
        let c = self.claims.get(&claim_id.0).cloned().unwrap_or_else(|| env::panic_str("no claim"));
        require!(c.status == ClaimStatus::Pending, "claim not pending");
        require!(env::block_timestamp() >= c.submitted_at.0 + self.challenge_window_ns, "challenge window still open");
        let o = self.orders.get(&c.order_id.0).unwrap();
        let suspended = self.listings.get(&o.listing_id.0).unwrap().status == ListingStatus::Suspended;
        if o.trial && suspended {
            // The seller claimed probe usage before the F grade landed.
            let o = self.orders.get_mut(&c.order_id.0).unwrap();
            o.pending = U128(o.pending.0 - c.amount.0);
            let c = self.claims.get_mut(&claim_id.0).unwrap();
            c.status = ClaimStatus::Rejected;
            c.resolution = Some("probe usage on a listing graded F is not paid".into());
            emit("claim_rejected", near_sdk::serde_json::json!({"claim_id": claim_id, "reason": "trial order on a listing graded F"}));
            return;
        }
        self.pay_claim(claim_id.0);
    }

    // ----------------------------------------------------------------- views

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            grader: self.grader.clone(),
            min_bond: U128(self.min_bond),
            min_deposit: U128(self.min_deposit),
            challenge_window_sec: self.challenge_window_ns / SEC,
            max_grade_age_sec: self.max_grade_age_ns / SEC,
            offer_ttl_max_sec: self.offer_ttl_max_ns / SEC,
            trial_cap: U128(self.trial_cap),
        }
    }

    pub fn get_stats(&self) -> Stats {
        Stats {
            listings: self.next_listing,
            offers: self.next_offer,
            orders: self.next_order,
            claims: self.next_claim,
            volume_paid: U128(self.volume_paid),
            slashed_total: U128(self.slashed_total),
            tokens_settled: U64(self.tokens_settled),
        }
    }

    pub fn get_listing(&self, listing_id: U64) -> Option<Listing> {
        self.listings.get(&listing_id.0).cloned()
    }

    pub fn get_listings(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Listing> {
        let from = from.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.next_listing).filter_map(|i| self.listings.get(&i).cloned()).take(limit as usize).collect()
    }

    /// True when the listing can be bought right now.
    pub fn is_tradable(&self, listing_id: U64) -> bool {
        self.listings.get(&listing_id.0).map(|l| self.tradable_reason(l).is_none()).unwrap_or(false)
    }

    pub fn get_offer(&self, offer_id: U64) -> Option<Offer> {
        self.offers.get(&offer_id.0).cloned()
    }

    pub fn get_offers(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Offer> {
        let from = from.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.next_offer).filter_map(|i| self.offers.get(&i).cloned()).take(limit as usize).collect()
    }

    pub fn get_order(&self, order_id: U64) -> Option<Order> {
        self.orders.get(&order_id.0).cloned()
    }

    pub fn get_orders(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Order> {
        let from = from.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.next_order).filter_map(|i| self.orders.get(&i).cloned()).take(limit as usize).collect()
    }

    pub fn get_claim(&self, claim_id: U64) -> Option<Claim> {
        self.claims.get(&claim_id.0).cloned()
    }

    pub fn get_claims(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Claim> {
        let from = from.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.next_claim).filter_map(|i| self.claims.get(&i).cloned()).take(limit as usize).collect()
    }

    // --------------------------------------------------------------- private

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only owner");
    }

    fn only_grader(&self) {
        require!(env::predecessor_account_id() == self.grader, "only grader");
    }

    fn seller_listing(&mut self, id: u64) -> &mut Listing {
        let caller = env::predecessor_account_id();
        let l = self.listings.get_mut(&id).unwrap_or_else(|| env::panic_str("no listing"));
        require!(l.seller == caller, "only seller");
        l
    }

    fn tradable_reason(&self, l: &Listing) -> Option<&'static str> {
        if l.status == ListingStatus::Suspended {
            return Some("listing graded F");
        }
        if l.status != ListingStatus::Active {
            return Some("listing not active");
        }
        let Some(g) = &l.grade else { return Some("listing not graded") };
        if g.tier == Tier::F {
            return Some("listing graded F");
        }
        if env::block_timestamp() > g.graded_at.0 + self.max_grade_age_ns {
            return Some("grade is stale");
        }
        if l.capacity_tokens.0 == 0 {
            return Some("no capacity left");
        }
        None
    }

    fn tradable(&self, id: u64) -> &Listing {
        let l = self.listings.get(&id).unwrap_or_else(|| env::panic_str("no listing"));
        if let Some(reason) = self.tradable_reason(l) {
            env::panic_str(reason);
        }
        l
    }

    fn party_to_move(&self, offer_id: u64) -> Party {
        let o = self.offers.get(&offer_id).unwrap_or_else(|| env::panic_str("no offer"));
        require!(o.status == OfferStatus::Open, "offer not open");
        require!(env::block_timestamp() <= o.expires_at.0, "offer expired");
        let caller = env::predecessor_account_id();
        let seller = &self.listings.get(&o.listing_id.0).unwrap().seller;
        let me = if &caller == seller {
            Party::Seller
        } else if caller == o.buyer {
            Party::Buyer
        } else {
            env::panic_str("only buyer or seller");
        };
        require!(o.moves.last().unwrap().by != me, "wait for the other party");
        me
    }

    #[allow(clippy::too_many_arguments)]
    fn open_order(&mut self, listing_id: u64, buyer: AccountId, buyer_key: String, kind: OrderKind, price_in: U128, price_out: U128, deposit: u128, trial: bool) -> U64 {
        require!(deposit >= self.min_deposit, "deposit below min_deposit");
        check_key(&buyer_key);
        let l = self.listings.get_mut(&listing_id).unwrap();
        require!(l.seller != buyer, "seller cannot buy own listing");
        l.open_orders += 1;
        let id = self.next_order;
        self.next_order += 1;
        self.orders.insert(
            id,
            Order {
                id: U64(id),
                listing_id: U64(listing_id),
                buyer: buyer.clone(),
                buyer_key,
                kind,
                trial,
                price_in,
                price_out,
                deposit: U128(deposit),
                spent: U128(0),
                pending: U128(0),
                status: OrderStatus::Open,
                opened_at: U64(env::block_timestamp()),
                close_requested_at: None,
            },
        );
        emit("order_opened", near_sdk::serde_json::json!({"order_id": U64(id), "listing_id": U64(listing_id), "buyer": buyer, "kind": kind, "price_in": price_in, "price_out": price_out, "deposit": U128(deposit), "trial": trial}));
        U64(id)
    }

    fn pay_claim(&mut self, claim_id: u64) {
        let c = self.claims.get(&claim_id).cloned().unwrap();
        let o = self.orders.get_mut(&c.order_id.0).unwrap();
        o.pending = U128(o.pending.0 - c.amount.0);
        o.spent = U128(o.spent.0 + c.amount.0);
        let listing_id = o.listing_id.0;
        let l = self.listings.get_mut(&listing_id).unwrap();
        let tokens = c.in_tokens.0 + c.out_tokens.0;
        l.capacity_tokens = U64(l.capacity_tokens.0.saturating_sub(tokens));
        l.tokens_sold = U64(l.tokens_sold.0 + tokens);
        let seller = l.seller.clone();
        self.volume_paid += c.amount.0;
        self.tokens_settled += tokens;
        self.claims.get_mut(&claim_id).unwrap().status = ClaimStatus::Paid;
        transfer(&seller, c.amount.0);
        emit("claim_paid", near_sdk::serde_json::json!({"claim_id": U64(claim_id), "amount": c.amount, "seller": seller}));
    }
}

#[cfg(test)]
mod tests;

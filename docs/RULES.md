# Market rules

These are the rules the contract (`contract/src/lib.rs`) enforces. Amounts are native NEAR in yoctoNEAR; prices are yoctoNEAR per 1M tokens.

## Listings

- A seller lists one model, one OpenAI-compatible endpoint, the ed25519 key its node signs receipts with, an ask (input and output price), a token capacity and a bond of at least `min_bond`.
- The seller can change the ask at any time (the spot price). Locked orders keep their price.
- A new endpoint clears the grade. A listing closes and returns its bond only with no open orders or offers.

## Grades

- Only the `grader` account posts grades: tier A, B, C or F, a score, the checks that passed, latency, error rate and the sha256 of the full report.
- A passing tier (A, B, C) requires `fingerprint_ok` and `metering_ok`. Tier A also requires `attested`. The contract refuses a grade that breaks these rules.
- F suspends the listing. A later passing grade lifts the suspension.
- A listing can be bought only when it is Active, its grade is not F, the grade is younger than `max_grade_age_sec` and capacity is left.
- An ungraded or stale listing accepts only spot orders up to `trial_cap`. The grader probes through these trial orders like any buyer.

## Buying

- **Spot** (`buy_spot`): the deposit is the budget; the price is the ask at the moment of the fill.
- **On-demand tab** (`open_tab`): the buyer sets a ceiling. Each claim is priced at the seller's ask when the claim is made, capped at the ceiling.
- **Bargain** (`make_offer`, `counter_offer`, `accept_offer`, `end_offer`): the buyer escrows a deposit with an offer. Buyer and seller alternate; at most 4 moves. The party that did not make the last move may accept, which opens a Negotiated order at the last price. The seller can reject and the buyer can withdraw. Anyone can expire an offer after its TTL. Every ending refunds the deposit.
- Each order carries an ed25519 key the buyer signs gateway requests with.

## Settlement

- The seller node signs a receipt for every answer: listing, order, sequence number, sha256 of the request and response, input and output tokens.
- The seller claims a batch (`submit_claim`) with the token sums, the receipt count and the sha256 of the receipt texts. A claim cannot exceed the order's remaining budget.
- The buyer has `challenge_window_sec` to dispute. After that anyone can finalize and the seller is paid.
- The grader resolves a dispute. It asks the seller node for the receipts behind the claim and upholds only if every signature is valid, every receipt is for this order, the hash matches and the sums equal the claim. Otherwise the claim is rejected and up to the requested slash (twice the claim, at least 0.01 NEAR, capped at the bond) goes from the seller's bond to the buyer.
- Probe usage on a trial order is never paid once the listing is graded F: `submit_claim` refuses it and `finalize_claim` rejects a claim made before the grade landed.
- Closing an order gives the seller one challenge window to claim, then anyone can settle and the unspent deposit returns to the buyer. On a suspended listing the buyer can leave at once.

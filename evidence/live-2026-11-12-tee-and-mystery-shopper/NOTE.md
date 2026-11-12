# Live run: per-answer TEE checks, substitution disputes and mystery-shopper re-grades

Contract `market.credster-live-mwdmcl3xeo2.testnet`, served from https://credster.store, 12 Nov 2026 22:17 to 22:43 UTC. Upstream for every seller is NEAR AI Cloud. `server.log` is the keeper and seller-node log for that window. For this run the mystery-shopper window was 4 to 7 minutes after a grade; it was set back to 2 to 4 hours afterwards.

## Overclaim caught by a mystery shopper, with no buyer involved

Listing #5 (`z-ai/glm-5.3-flash`, overclaim persona) held grade A. Its persona bills the grader's trial orders honestly and triples every other order.

1. The keeper funded a fresh implicit account and re-graded #5 as an ordinary customer.
2. The seller claimed 1080 in / 1869 out against the shopper's receipts for 360 in / 623 out. The shopper disputed (tx `GVcFvD3TKZSqxhWEXGBux3DMf2cc1dadCaLVV8cP8cUq`).
3. The grader rejected claims 15, 16 and 17 and slashed 0.01 NEAR of the bond on each (txs `6dPx83n4nNp43Qby4xCdAWVqM95Q9LCmXKUJtCJ6HJyd`, `Dg6qNwdDKrRwiEoAw2sj6qm1CFkCbPFjPKuNngmt9vVN`, `DwP4e36RFZZwrvLD91Qt3ZvU4zcbbiSkHsJSi1WNFJmu`).
4. The keeper posted grade F with a claims-audit report and suspended #5 (tx `6E4jPoihGFb82jjKM8M4cPTjt6D1ycRk686j8wphqLeP`).

## Bait and switch caught by a buyer's page, then by a mystery shopper

Listing #6 (`Qwen/Qwen3.8-27B`, switch persona) serves the real model to trial orders and `Qwen/Qwen3.6-35B-A3B-FP8` to everyone else.

1. Its trial grade was A (tx `B6ovM2QGeMGtCWRBBgcyfWybQG4SqTYVp1BFN9paZCDp`).
2. A buyer opened order 21 in a browser on credster.store and asked one question. The page showed `✓ signed by the node key on chain`, `✓ request hash`, `✓ response hash` and `✗ TEE: the TEE signature shows Qwen/Qwen3.6-35B-A3B-FP8 answered, not Qwen/Qwen3.8-27B`.
3. The seller claimed the answer (claim 40). The page disputed it on its own. The grader fetched the TEE signature for that receipt from the seller node, found it names the other model, rejected the claim and slashed 0.01 NEAR to the buyer (tx `FGRY3UUoXprDGXunAUwf7Ybhxvms2CMhjRgc6rw37tGz`). The resolution on chain reads: "receipts sum 23 in / 24 out vs claim 23 / 24; TEE check on answer #14: contradicts".
4. The next mystery-shopper re-grade graded #6 F on both checks: token counts match Qwen3.6-35B-A3B and the TEE signature names it (tx `7ofm7Rnw86oLs5CwDARUhfDzSYEaRJg8sjR7R9eMgmDR`).

## A false F, its cause and the fix

At 22:21 and 22:24 the grader failed two honest Qwen3.8-27B listings (#0 tx `8mTpHKFqxYYxtvcYtxZ1cZzX9xdvSKrFr8jSDSk48i7e`, #6 tx `FFCNJQ7HBAvL1bVm1i6XxY4F4Xd2httAoC7G4pwqzzsH`). Their third probe returned 109 prompt tokens against a stored reference of 110. Three fresh calls straight to NEAR AI gave `[117, 103, 109]` every time, so the provider's count had changed since the reference was measured that morning (Qwen3.6-35B-A3B also moved, 68 to 67). The grader now measures the claimed model's reference at the provider during each grade (cached 30 minutes). `fingerprints.json` was re-measured too. Both listings were re-listed at the same endpoint (txs `4i9pu96EMKU2QMA8UyWdwRdSBpzHyBF6tmDasMqQLrDi`, `5RvSzXVxJAXKPD3MvzrgskugrRmpnatdQH4rUCT9Umng`), which cleared the grades; #0 and #6 were graded A again on the next pass. The two F grades stay in each listing's `f_grades` count on chain.

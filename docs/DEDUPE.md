# Dedupe against the NEAR HACKATHON directory

Checked 2026-11-12 06:30 UTC. The public directory (`https://nearhackathon.com/api/projects`) listed **649** submissions. The directory search only matches project names, so I also fetched the text of every demo post (617 of 649 readable; the other 32 link to sites or videos. None of their names suggest an AI-credit market). The directory snapshot is in `evidence/dedupe/directory-2026-11-12.json` and the fetch script is `evidence/dedupe/fetch_posts.py`.

## Nearest neighbours

| Project | What it does | How Credster differs |
| --- | --- | --- |
| KeyLease | Seal an API key in a TEE proxy, lease N calls to agents, revoke. | KeyLease shares access to one owner's key. It does not price, trade or grade anything. Credster is a market: many sellers, spot, bargaining and on-demand orders. It also has a grade that says whether the seller serves the model it claims. |
| Hivebuy | Buyer agents pool demand; providers share one order at a clearing price; buyers redeem provider-signed vouchers. | Hivebuy runs a group auction and trusts that the provider runs the model it says. Credster grades each seller's endpoint and blocks trading on a failed grade. It also has bilateral bargaining and a pay-as-you-go tab. |
| C0-op, SwarmCompute, SealedSwarm, HiveBid, SwarmBid | Group buying or sealed-bid auctions for GPU hours or compute. | Auction mechanics only. None checks the quality or identity of what is sold. |
| MARGIN | A rule-based broker agent that buys intelligence wholesale and sells it retail. | A single broker. No seller verification, no on-chain metering disputes. |
| Sumplus CATS Service Pass | Spending cap, signed usage settled on NEAR, refund of unused funds. | Closest to our settlement half. Its demo uses simulated AI usage. Credster meters real calls with seller-signed receipts and lets the buyer dispute a claim. |
| PayPerCall on NEAR, Inari | Per-call escrow, pay on verified answer. | Per-call escrow without a market or a grade. |
| GhosterDex | An agent buys private AI from its own balance. | A buyer of NEAR AI credits, not a market between sellers and buyers. |
| BlindBench, Laurel, Hive | Private evals or answer grading in a TEE. | They grade answers to a task. Credster grades a **seller endpoint**: does it serve the claimed model, does it meter honestly, is it fast and up. |
| TokenGo, ZeroFlux | A game with AI-credit loot; a compute token with long/short markets on models. | Different product. |

## Gap

No listed project checks that a reseller actually serves the model it advertises or that its usage numbers are honest. That is the main fraud in AI-credit resale (a cheaper model behind an expensive name, inflated token counts). Credster's grading engine targets exactly that. The market only lets graded listings trade.

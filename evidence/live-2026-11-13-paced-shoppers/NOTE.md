# Live run: mystery shoppers that behave like customers

Contract `market.credster-live-mwdmcl3xeo2.testnet` on https://credster.store, 13 Nov 2026 00:40 to 02:58 UTC, upstream NEAR AI Cloud. `server.log` is the keeper log for the window. One error line repeated 163 times is left out; it is described below. For the run, pauses between a shopper's calls were shortened (5 to 15 s, then 20 to 40 s) and visits came every 1 to 4 minutes. Production settings (pauses of 20 to 90 s, the order kept open 10 to 40 minutes, a visit every 2 to 4 hours) were restored at the end.

## What a visit looks like now

Listing #9 (bait-and-switch persona, trial grade A, tx `9KVqhhDx1tPffm4hT3kMwbvTXst9ajCGHX9V8yeiAhHQ`) was visited at 02:06 by `cedar-nova-10050.testnet`, a named account the public testnet faucet created for the shopper pool an hour earlier. From the grade report (order 43):

- A spot order with a 0.04 NEAR deposit (deposits vary from 0.03 to 0.08; about 3 visits in 10 use a tab).
- Seven requests in the live page's own JSON shape, shuffled, with pauses of 9, 7, 11, 15, 13 and 14 s. Examples: "Is there a bug here? Explain briefly." over a short Python snippet, "Translate this into French: ...", "Suggest three names for a chess app in Tromsø.", "Quick check: 439 seats times 74 rows, how many seats is that?" and "Sort these ages from youngest to oldest: ...".
- Fingerprint from the first three: observed `[44, 29, 23]` against `[44, 29, 65]` measured at NEAR AI for the same bodies. The counts match Qwen3.6-35B-A3B. The TEE signature named that model too, so #9 was graded F and suspended (tx `12w41LZzMJ9vhakFtQPFJsMHaYni6hxvyT432VYJu5f1`).
- The visit was not in the public activity feed while it ran. The order was left open and closed by the keeper later.

## Two problems found and fixed during the run

1. **The live page's per-model options hid the sibling swap from the fingerprint.** With `enable_thinking: false`, Qwen3.8-27B and Qwen3.6-35B-A3B gave the same prompt counts on natural prompts (listing #8 at 00:56: counts matched, the TEE signature still caught it). Now at least one fingerprint request per visit goes without options, as other OpenAI clients send it. That is how #9's third count (23 against 65) exposed the swap.
2. **A paced visit outlasts each claim's 60 s challenge window.** At 02:06 the seller claimed each of #9's answers within seconds and every claim was paid before the visit ended (claims 127 to 132). The keeper now starts auditing the shopper's bill as soon as the order opens. On listing #11 at 02:51 to 02:56, the shopper disputed each claim on its TEE check while the visit was still running. All seven claims (187 to 193) were rejected, with 0.01 NEAR slashed to the shopper on each. The grade landed at the end (F).

## An outage this caused, and the fix

From 02:17 to 02:39 the keeper's settle lane failed on every tick ("The path argument must be of type string. Received null"). For those 22 minutes no claims were paid and no closing orders were refunded. The cause was a trial grade, not a shopper visit, registering itself in the shopper audit list with no report. The fix: only shopper visits register; entries without a shopper are dropped on load; each audit entry runs in its own try block, so one bad entry cannot stop settlement again. After the restart the backlog settled within a minute (order 48's seven claims were paid). The grader also ran low on NEAR during the run because test visits used grader-funded shoppers; it was topped up with 1.5 NEAR from the parent (tx `ALWfd2pE9ckpqLXfRXWZF9sMj5ZeFGPqNsfnLSGhXWuv`).

## Faucet rationing

The public testnet faucet answered `429 Rate limit exceeded, retry in 1 hour` after a few accounts. The keeper now fills a pool of faucet-funded shopper accounts at about one an hour (up to 6) and takes one per visit. When the pool is empty it waits instead of funding a traceable shopper. It only falls back to a grader-funded shopper when a grade is close to going stale. The test runs above that used grader-funded shoppers set `TS_SHOPPER_ALLOW_GRADER=1` to avoid waiting an hour per visit.

# Trying Credster live

Credster runs on NEAR testnet. A live server hosts the website, six seller nodes (one honest, one honest without TEE signatures, four that cheat on purpose), the grader, and a keeper that settles payments, refunds and disputes. You can buy, sell and dispute against it with free test NEAR.

The live URL is in the repository description and the submission. Below it is written `https://LIVE`. The live market is its own testnet contract, shown on the page. The recorded run in the README stays untouched on `market.credster-68480.testnet`.

## In the browser (about 3 minutes)

Open `https://LIVE/live.html`. Nothing to install and no wallet: the page creates a throwaway testnet account in your browser.

1. **Get test NEAR.** One click creates the account and the faucet sends it 0.1 NEAR. The key stays in your browser's local storage, and **export key** shows it if you want to keep using the account from the CLI.
2. **Buy from the honest seller** (`Qwen3.8-27B`, graded A). Pick spot, a pay-as-you-go tab, or bargain with the seller's agent.
3. **Chat.** Every answer comes with a receipt signed by the seller node. The page checks three things in your browser: the signature matches the node key registered on chain, the receipt's request hash matches the exact bytes you sent, and its response hash matches the exact bytes you got.
4. **Check the bill.** About 15 seconds later the seller claims what it served. The page compares the claim with your receipts. After the 60-second challenge window the keeper pays the claim.
5. **Catch a cheat.** Buy from the seller tagged *cheats on purpose: Overclaim*. It passed grading because it bills the grader honestly, but it claims three times what it served you. Your page sees the gap and disputes the claim. The grader then checks the seller's own receipts, rejects the claim, and sends 0.01 NEAR of the seller's bond to you. Watch your balance go up.
6. **Launch a seller.** On the right, pick a behaviour (model swap, sibling swap, inflated billing, overclaim or honest) and launch it. The server creates a seller account, posts its 0.2 NEAR bond, lists it and starts its node. Within about a minute the grader buys a trial order, probes the node, and posts a grade. The model swap gets an F because its token counts fit another model and its TEE signature names that model. An F suspends the listing, and the grade report's hash is checked in your browser.
7. **Close the order.** What you didn't spend comes back after the claim window.

Everything the page does is an ordinary contract call or a signed request to a seller node, so you can follow each step on [NearBlocks](https://testnet.nearblocks.io) through the transaction links. The **Dashboard** page shows every listing, order, offer and claim on the contract.

## From a terminal (about 10 minutes)

Needs Node 22. No near CLI, no Rust.

```sh
git clone https://github.com/zkasuran/credster && cd credster/node && npm install
export TS_CONTRACT=<contract shown on the live page>
node src/cli.js new-account --faucet https://LIVE     # 0.1 NEAR from the live faucet
# or: node src/cli.js new-account                     # 10 NEAR from the public testnet faucet
node src/cli.js listings
node src/cli.js buy-spot --buyer <account> --listing <id> --deposit 0.02
node src/cli.js chat --buyer <account> --order <order> --prompt "hello"
node src/cli.js audit --buyer <account> --order <order> --dispute    # disputes claims your receipts don't cover
node src/cli.js open-tab --buyer <account> --listing <id> --ceiling-in 0.1 --ceiling-out 0.4 --deposit 0.02
node src/cli.js make-offer --buyer <account> --listing <id> --price-in 0.06 --price-out 0.22 --deposit 0.02
node src/cli.js offer --offer <offer>                                # the seller agent answers within seconds
node src/cli.js accept --as <account> --offer <offer>
node src/cli.js close --buyer <account> --order <order>              # the keeper refunds after 60 s
node src/cli.js help                                                 # every command
```

Keys go to `~/.near-credentials/testnet/`, in the same format the near CLI uses. Set `TS_CREDENTIALS` to keep them somewhere else.

## Sell with your own NEAR AI Cloud key (about 15 minutes)

The seller node keeps your upstream key on your machine; buyers never see it. The grader has to reach your node, so expose it with a tunnel first.

```sh
node src/cli.js new-account --name my-seller                         # 10 NEAR
cloudflared tunnel --url http://localhost:8701                       # prints https://<random>.trycloudflare.com
node src/cli.js seller-list --name mine --seller <account> --model Qwen/Qwen3.8-27B \
  --endpoint https://<random>.trycloudflare.com/v1 --ask-in 0.08 --ask-out 0.30 --bond 0.2
TS_UPSTREAM_KEY=<NEAR AI Cloud key> node src/cli.js seller-serve --name mine --port 8701
```

The live server's keeper grades any new listing on the contract, usually within a minute, as long as the endpoint answers. Buy from your own listing with a second account, or use the browser page. Models need a reference fingerprint in `node/fingerprints.json`; a model without one is graded F. `seller-serve --mode swap|inflate|overclaim` runs the same cheats the demo personas use.

## What is trusted

- **The grader is one account.** The contract only accepts grades and dispute decisions from it. Its reports are public and hash-bound, and anyone can rerun a grade with `node src/cli.js grade --listing <id> --grader <any funded account> --no-post`.
- **The keeper is a convenience.** Finalizing claims, settling closes and expiring offers are calls anyone can make (`finalize`, `settle`, `end-offer` in the CLI).
- **The live server runs the demo sellers and the faucet.** It holds those sellers' keys and pays their NEAR AI bills, so their calls are capped: 1024 output tokens per call, 30 calls per order, and a daily total. The faucet is rate-limited per network and per account.

## Running the live server

For the project's operator. It needs Node 22, a NEAR AI Cloud key, and a public URL for the server.

```sh
cd credster
# A. A fresh deployment (recommended). No keys needed: the public testnet faucet funds it,
#    the contract code is copied from the recorded run's market, and six persona listings are created.
node scripts/go-live.mjs --fresh --top-up 2 --public-url https://LIVE
# B. Or reuse the recorded run's deployment. Needs the keys setup-testnet.sh saved in
#    ~/.near-credentials/testnet: the parent, grader.<parent> and the six s-*.<parent> sellers.
P=credster-68480.testnet node scripts/go-live.mjs --public-url https://LIVE

set -a; . ~/.credster/live.env; set +a
export TS_UPSTREAM_KEY=<NEAR AI Cloud key>
node node/src/cli.js live                                            # listens on :8080
```

Prefer A. With B, `go-live` moves each existing seller listing to `https://LIVE/s/<persona>/v1` with a new node key. The contract clears a moved listing's grade and the keeper grades it again, so **the grades from the recorded run (listings #6 to #11) are replaced on chain**. Their reports stay in `web/reports/` and the transactions in `evidence/`, but the landing page and `verify-reports` then check the new grades. With A, the recorded contract stays exactly as the README describes it.

To serve from your own machine, run `cloudflared tunnel --url http://localhost:8080` and use the printed URL as `TS_PUBLIC_URL`. A quick tunnel's URL changes each time it restarts. When `TS_PUBLIC_URL` changes, the server moves its listings to the new URL on startup and they are graded again.

On a host (Fly.io, Railway, Render, a VPS), build the image from `Dockerfile` and mount a volume at `/data`. The server state goes in `/data/credster` and the NEAR keys in `/data/near-credentials`: copy in what `go-live` wrote.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TS_CONTRACT` | | market account |
| `TS_PUBLIC_URL` | | the URL visitors and the grader reach this server at |
| `TS_UPSTREAM_KEY` | | NEAR AI Cloud key used by the hosted seller nodes |
| `TS_PARENT` | from `market.<parent>` | funds launched sellers; their accounts are its sub-accounts |
| `TS_FAUCET` | `TS_PARENT` | account the faucet pays from |
| `TS_GRADER` | from `get_config` | grader account (its key must be in the keychain) |
| `TS_RPC` | FastNEAR, then rpc.testnet.near.org | comma-separated RPC endpoints, rotated on rate limits |
| `TS_FAUCET_AMOUNT` | `0.1` | NEAR per account |
| `TS_FAUCET_PER_IP_HOUR` / `TS_FAUCET_PER_DAY` | `3` / `200` | faucet limits |
| `TS_LAUNCH_MAX` / `TS_LAUNCH_TTL_MIN` / `TS_LAUNCH_PER_IP_HOUR` | `8` / `120` / `3` | launched sellers |
| `TS_NODE_MAX_TOKENS` / `TS_NODE_CALLS_PER_ORDER` / `TS_NODE_CALLS_PER_DAY` | `1024` / `30` / `3000` | caps on the hosted nodes' upstream spend |
| `TRUST_PROXY` | off (`1` in Docker) | take the client IP from `CF-Connecting-IP` / `X-Forwarded-For` for rate limits. Set `1` behind cloudflared or a reverse proxy; leave it off when clients connect directly, or they can spoof the header |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | |

To try the server without a NEAR AI key, `node node/test/mock-upstream.mjs 9100` runs a stand-in provider that answers the grader's tasks and signs like a TEE. Point the server at it with `TS_UPSTREAM_URL=http://127.0.0.1:9100 TS_PROVIDER=http://127.0.0.1:9100 TS_UPSTREAM_KEY=mock`. Answers from the stand-in are canned text, and the page shows them as such.

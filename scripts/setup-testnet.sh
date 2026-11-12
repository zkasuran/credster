#!/usr/bin/env bash
# Creates a fresh Credster deployment on NEAR testnet:
# a faucet-funded parent account, the market contract, a grader, six seller
# accounts and two buyers as sub-accounts. Writes .env with P and TS_CONTRACT.
# Needs: near CLI (near-cli-rs), cargo-near, and the wasm32 target.
set -euo pipefail
cd "$(dirname "$0")/.."
P="${1:-credster-$(date +%s | tail -c 6)}.testnet"
near account create-account sponsor-by-faucet-service "$P" autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
sleep 3
sub() { near account create-account fund-myself "$1.$P" "$2 NEAR" autogenerate-new-keypair save-to-legacy-keychain sign-as "$P" network-config testnet sign-with-legacy-keychain send; }
sub market 3.2
for a in grader:0.6 s-honest:0.35 s-swap:0.35 s-sibling:0.35 s-inflate:0.35 s-deepseek:0.35 s-overclaim:0.35 b-alice:0.7 b-bob:0.7; do sub "${a%%:*}" "${a##*:}"; done
(cd contract && cargo near build non-reproducible-wasm)
near contract deploy "market.$P" use-file contract/target/near/credster_market.wasm \
  with-init-call new json-args "{\"grader\":\"grader.$P\",\"min_bond\":\"200000000000000000000000\",\"min_deposit\":\"10000000000000000000000\",\"challenge_window_sec\":60,\"max_grade_age_sec\":86400,\"trial_cap\":\"50000000000000000000000\"}" \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send
printf 'P=%s\nTS_CONTRACT=market.%s\n' "$P" "$P" > .env
echo "wrote .env for $P"

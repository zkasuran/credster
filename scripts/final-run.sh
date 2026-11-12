#!/usr/bin/env bash
# Cleans up the previous run, then runs the full demo.
# Needs NEARAI_API_KEY in the environment (your own NEAR AI Cloud key).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${NEARAI_API_KEY:?set NEARAI_API_KEY to your own NEAR AI Cloud key}"
set -a; . ./.env; set +a
node scripts/cleanup.mjs
sleep 65   # orders closed above give the seller one claim window
node scripts/cleanup.mjs
node scripts/demo.mjs

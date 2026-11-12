# Stopped run (grading only)

This run on `market.credster-68480.testnet` was stopped by hand at step 7 to sort out which NEAR AI key to use, not because of a failure. Steps 1 to 6 completed: six listings (ids 0 to 5), their grades (A, F, F, F, B, A) and spot trading. The grade reports for listings 0 to 5 are in `web/reports/`; `node src/cli.js verify-reports` checks that each one hashes to the `report_hash` on chain. `scripts/cleanup.mjs` then settled its orders. The full run is the other `run-*` folder.

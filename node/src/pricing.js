// Shared price math. Prices are yoctoNEAR per 1M tokens, same as the contract.
const M = 1_000_000n;

export function cost(inTokens, outTokens, priceIn, priceOut) {
  const num = BigInt(inTokens) * BigInt(priceIn) + BigInt(outTokens) * BigInt(priceOut);
  return (num + M - 1n) / M;
}

/** Unit prices a claim on this order would use right now. */
export function orderPrices(order, listing) {
  if (order.kind === "OnDemand") {
    const pi = BigInt(listing.ask_in) < BigInt(order.price_in) ? BigInt(listing.ask_in) : BigInt(order.price_in);
    const po = BigInt(listing.ask_out) < BigInt(order.price_out) ? BigInt(listing.ask_out) : BigInt(order.price_out);
    return [pi, po];
  }
  return [BigInt(order.price_in), BigInt(order.price_out)];
}

export function remaining(order) {
  return BigInt(order.deposit) - BigInt(order.spent) - BigInt(order.pending);
}

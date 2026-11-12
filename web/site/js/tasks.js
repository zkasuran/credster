// The grader's checkable tasks, ported line for line from node/src/probes.js
// (rng + capabilityTasks) so a seed on this page gives the same four tasks.

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const letters = "abcdefghijklmnopqrstuvwxyz";

/** Four tasks with their expected answers, in the order the grader asks them. */
export function capabilityTasks(seed) {
  const r = rng(seed);
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const word = (n) => Array.from({ length: n }, () => letters[int(0, 25)]).join("");
  const a = int(301, 989), b = int(211, 977);
  const w = word(11);
  const nums = Array.from({ length: 7 }, () => int(10, 99));
  const s = word(24);
  const ch = s[int(0, 23)];
  const count = [...s].filter((c) => c === ch).length;
  return [
    { id: "multiply", q: `Compute ${a} × ${b}`, a: String(a * b) },
    { id: "reverse", q: `Reverse “${w}”`, a: [...w].reverse().join("") },
    { id: "sort", q: `Sort ${nums.join(", ")}`, a: [...nums].sort((x, y) => x - y).join(", ") },
    { id: "count", q: `Count “${ch}” in “${s}”`, a: String(count) },
  ];
}

export function randomSeed() {
  const u = new Uint32Array(1);
  crypto.getRandomValues(u);
  return u[0] || 1;
}

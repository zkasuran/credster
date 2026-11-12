// Probe sets used by the grading engine.
//
// Fingerprint probes: fixed texts whose prompt token count depends on the
// model's tokenizer and chat template. The counts are deterministic for a
// given model (measured, see fingerprints.json) and differ between models,
// so a reseller that serves a different model, or rescales usage, shows up.
//
// Capability tasks: generated fresh from a random seed for every grading run,
// with answers the grader can check exactly, so they cannot be cached.

export const FINGERPRINT_PROBES = [
  "Fingerprint: ñandú 東京 🧪 0x7f3a9 «quoted» naïve façade — ∑∫√ ﷽ ⟨tok⟩ 12345678901234567890 supercalifragilistic",
  "def f(xs):\n    return {k: v for k, v in zip(xs, xs[1:]) if k != v}  # 🚀  Ωmega\n\tSELECT * FROM t WHERE id IN (1,2,3);",
  "In 1879, 42 nautical miles off Reykjavík, the ship 'Þórshöfn' logged 3.14159 knots; Κύριε, Привет, مرحبا, नमस्ते, 안녕하세요, こんにちは.",
];

export function fingerprintRequest(model, i) {
  return { model, messages: [{ role: "user", content: FINGERPRINT_PROBES[i] }], max_tokens: 16, temperature: 0 };
}

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

/** Four checkable tasks. `check(text)` returns true for a correct answer. */
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
  const lastLine = (t) => String(t || "").trim().split("\n").filter(Boolean).pop() || "";
  const digits = (t) => lastLine(t).replace(/[^0-9]/g, "");
  return [
    { id: "multiply", prompt: `Compute ${a} * ${b}. Reply with only the number.`, check: (t) => digits(t) === String(a * b) },
    { id: "reverse", prompt: `Reverse the string "${w}" character by character. Reply with only the reversed string.`, check: (t) => lastLine(t).replace(/[^a-z]/g, "") === [...w].reverse().join("") },
    { id: "sort", prompt: `Sort these numbers in ascending order: ${nums.join(", ")}. Reply with only the numbers separated by commas.`, check: (t) => (lastLine(t).match(/\d+/g) || []).join(",") === [...nums].sort((x, y) => x - y).join(",") },
    { id: "count", prompt: `How many times does the letter "${ch}" appear in "${s}"? Reply with only the number.`, check: (t) => digits(t) === String(count) },
  ];
}

export function capabilityRequest(model, task) {
  return { model, messages: [{ role: "user", content: task.prompt }], max_tokens: 2048, temperature: 0 };
}

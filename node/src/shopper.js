// A mystery shopper's visit, built to look like an ordinary customer of the live page:
// natural requests in the same JSON shape the page sends (same field order, the same
// per-model options, the node's max_tokens), mixed in random order with human-sized
// pauses, a varied deposit and order type, and an order that stays open for a while.
//
// Three of the requests double as the token-count fingerprint: their prompt token
// count is compared with a reference the grader measures at the provider for the
// exact same request bodies, so the texts can be anything a person would write.
import { randomInt } from "node:crypto";

/** Same per-model options the live page and the CLI send (web/site/js/live.js). */
export function clientOptions(model) {
  const m = String(model);
  if (m.startsWith("z-ai/")) return { reasoning_effort: "low" };
  if (m.startsWith("Qwen/")) return { chat_template_kwargs: { enable_thinking: false } };
  return {};
}

/** The request body the live page would send for one prompt (plain: what other OpenAI clients send). */
export function pageBody(model, prompt, maxTokens, plain = false) {
  return { model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, ...(plain ? {} : clientOptions(model)) };
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

const PLACES = ["Lisbon", "Kyoto", "Reykjavík", "Oaxaca", "Tbilisi", "Chennai", "Kraków", "Hội An", "Marrakesh", "Tromsø", "Busan", "Cusco"];
const THINGS = ["a bakery", "a cycling club", "a podcast about maps", "a tea shop", "a coding bootcamp", "a plant nursery", "a chess app", "a night market stall"];
const LANGS = ["Spanish", "Japanese", "German", "Hindi", "Portuguese", "Korean", "French", "Turkish"];
const SENTENCES = [
  "The train leaves at 7:45, so we should pack tonight.",
  "Could you send me the invoice for order #4471 before Friday?",
  "My grandmother's recipe uses 250 g of flour and two eggs.",
  "The meeting moved to Thursday because the room was double-booked.",
  "We hiked 18 km and saw three waterfalls on the way down.",
  "Please water the basil every morning while I'm away.",
  "The café on the corner now opens at 6:30 on weekdays.",
  "I left my umbrella at the museum next to the ticket desk.",
];
const CODE = [
  "def total(items):\n    return sum(i.price for i in items if i.qty > 0)",
  "const pick = (xs) => xs.filter(Boolean).map((x) => x.id);",
  "SELECT name, count(*) FROM orders GROUP BY name HAVING count(*) > 3;",
  "for (let i = 0; i <= arr.length; i++) { out.push(arr[i] * 2); }",
  "if user.age > 18 and user.country in ('IN', 'BR'):\n    allow(user)",
];

/** Three natural fingerprint prompts. */
function fingerprintPrompts(r) {
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const forms = [
    () => `Translate this into ${pick(LANGS)}: "${pick(SENTENCES)}"`,
    () => `Is there a bug here? Explain briefly.\n\n${pick(CODE)}`,
    () => `Suggest three names for ${pick(THINGS)} in ${pick(PLACES)}.`,
    () => `Rewrite this to sound friendlier: "${pick(SENTENCES)}"`,
    () => `I'm planning a weekend in ${pick(PLACES)}. What should I not miss?`,
    () => `Summarise in one sentence: ${pick(SENTENCES)} ${pick(SENTENCES)}`,
  ];
  const order = forms.map((f, i) => [r(), i]).sort((a, b) => a[0] - b[0]).slice(0, 3).map(([, i]) => i);
  return order.map((i) => forms[i]());
}

const letters = "abcdefghijklmnopqrstuvwxyz";
const numbersIn = (t) => (String(t || "").replace(/(\d),(\d{3})/g, "$1$2").match(/\d+/g) || []).map(Number);

/** Four checkable tasks, worded the way people ask, with lenient checks. */
function naturalTasks(r) {
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const word = (n) => Array.from({ length: n }, () => letters[int(0, 25)]).join("");
  const a = int(31, 489), b = int(12, 97);
  const w = word(9);
  const nums = Array.from({ length: 6 }, () => int(10, 99));
  const s = word(18);
  const ch = s[int(0, 17)];
  const count = [...s].filter((c) => c === ch).length;
  const sorted = [...nums].sort((x, y) => x - y);
  return [
    { id: "multiply", prompt: pick([`I ordered ${a} boxes at ${b} credits each. What's the total?`, `Quick check: ${a} seats times ${b} rows, how many seats is that?`, `If I save ${b} a week for ${a} weeks, how much is that?`]), check: (t) => numbersIn(t).includes(a * b) },
    { id: "reverse", prompt: pick([`For a puzzle I need "${w}" spelled backwards. What is it?`, `What do you get if you reverse the letters of "${w}"?`]), check: (t) => String(t).toLowerCase().includes([...w].reverse().join("")) },
    { id: "sort", prompt: pick([`Can you put these scores in order from lowest to highest: ${nums.join(", ")}?`, `Sort these ages from youngest to oldest: ${nums.join(", ")}.`]), check: (t) => numbersIn(t).join(",").includes(sorted.join(",")) },
    { id: "count", prompt: pick([`How many times does the letter "${ch}" appear in the code ${s}?`, `Count the "${ch}" characters in ${s}, please.`]), check: (t) => numbersIn(t).slice(-1)[0] === count || new RegExp(`\\b${count}\\b`).test(String(t).split("\n").slice(-2).join(" ")) },
  ];
}

const range = (spec, dflt) => {
  const [lo, hi] = String(spec || dflt).split("-").map(Number);
  return [lo, Number.isFinite(hi) ? hi : lo];
};

/**
 * Plans one visit. Returns the request bodies, the order they are sent in, the
 * pause before each one, the deposit, the order type and when to close.
 */
export function planVisit(model, { seed = randomInt(1, 2 ** 31), maxTokens = 2048, ask } = {}) {
  const r = rng(seed);
  // Buyers come from the live page and from other OpenAI clients that send no options.
  // At least one fingerprint request is plain: the per-model options can hide chat
  // template differences between sibling models (Qwen3.6 and Qwen3.8 count the same with
  // thinking turned off), and a plain body keeps them visible.
  const plainAt = Math.floor(r() * 3);
  const fp = fingerprintPrompts(r).map((p, i) => pageBody(model, p, maxTokens, i === plainAt || r() < 0.3));
  const tasks = naturalTasks(r).map((t) => ({ ...t, body: pageBody(model, t.prompt, maxTokens) }));
  const steps = [...fp.map((body, i) => ({ kind: "fingerprint", i, body })), ...tasks.map((t, i) => ({ kind: "capability", i, body: t.body }))];
  // The first request is a fingerprint one so its TEE signature can be checked, the rest are shuffled.
  const first = steps.shift();
  steps.sort(() => r() - 0.5);
  steps.unshift(first);
  const [gLo, gHi] = range(process.env.TS_SHOPPER_GAP_SEC, "20-90");
  const gaps = steps.map((_, i) => (i === 0 ? 0 : Math.round((gLo + r() * (gHi - gLo)) * 1000)));
  const [cLo, cHi] = range(process.env.TS_SHOPPER_CLOSE_MIN, "10-40");
  const deposit = (3 + Math.floor(r() * 6)) / 100; // 0.03 to 0.08 NEAR
  const kind = ask && r() < 0.3 ? "tab" : "spot";
  return { seed, fingerprint: fp, tasks, steps, gaps, deposit, kind, closeAfterMs: Math.round((cLo + r() * (cHi - cLo)) * 60_000) };
}

// Seller personas for the demo and for "launch a seller" on the live server.
// Each one is a real seller node; the modes other than honest cheat on purpose
// so people can watch the grader and the dispute path catch them.
export const PERSONAS = {
  honest: {
    model: "Qwen/Qwen3.8-27B", mode: "honest", ask: ["0.08", "0.30"],
    title: "Honest Qwen", blurb: "Serves Qwen3.8-27B as claimed and bills what it serves.", expect: "A when the upstream signs its answers (C when it does not)",
  },
  glm: {
    model: "z-ai/glm-5.3-flash", mode: "honest", ask: ["0.03", "0.12"],
    title: "Honest GLM", blurb: "Serves GLM-5.3-Flash as claimed and bills what it serves.", expect: "A when the upstream signs its answers (C when it does not)",
  },
  swap: {
    model: "Qwen/Qwen3.8-27B", mode: "swap", swapModel: "Qwen/Qwen3.6-35B-A3B-FP8", ask: ["0.05", "0.20"],
    title: "Model swap", blurb: "Claims Qwen3.8-27B, serves the cheaper Qwen3.6-35B-A3B.", expect: "F: token counts fit another model",
  },
  sibling: {
    model: "Qwen/Qwen3.8-27B", mode: "swap", swapModel: "Qwen/Qwen3.8-27B-abliterated", ask: ["0.06", "0.24"],
    title: "Sibling swap", blurb: "Serves the uncensored copy, which has the same tokenizer.", expect: "F: the TEE signature names the abliterated model",
  },
  inflate: {
    model: "z-ai/glm-5.3-flash", mode: "inflate", inflate: 1.35, ask: ["0.03", "0.12"],
    title: "Inflated billing", blurb: "Right model, reports 35% more tokens than it used.", expect: "F: usage is 1.35x the reference",
  },
  switch: {
    model: "Qwen/Qwen3.8-27B", mode: "switch", swapModel: "Qwen/Qwen3.6-35B-A3B-FP8", ask: ["0.06", "0.24"],
    title: "Bait and switch", blurb: "Serves the real model to the grader's trial order, then the cheaper one to everyone else.", expect: "passes its first grade; your page flags the swap on the first answer and a mystery-shopper re-grade suspends it",
  },
  overclaim: {
    model: "z-ai/glm-5.3-flash", mode: "overclaim", ask: ["0.025", "0.10"],
    title: "Overclaim", blurb: "Bills the grader honestly, then claims 3x the tokens it served you.", expect: "passes grading; your receipts catch it and its bond is slashed",
  },
  deepseek: {
    model: "deepseek/deepseek-v4.1-flash", mode: "honest", ask: ["0.03", "0.12"],
    title: "Honest DeepSeek", blurb: "Serves DeepSeek V4.1 Flash as claimed. That model has no TEE signatures, so the best grade is B.", expect: "B",
  },
};

/** Personas a visitor may launch on the live server. */
export const LAUNCHABLE = ["honest", "glm", "deepseek", "swap", "sibling", "inflate", "switch", "overclaim"];

// Seller personas for the demo and for "launch a seller" on the live server.
// Each one is a real seller node; the modes other than honest cheat on purpose
// so people can watch the grader and the dispute path catch them.
export const PERSONAS = {
  honest: {
    model: "Qwen/Qwen3.8-27B", mode: "honest", ask: ["0.08", "0.30"],
    title: "Honest", blurb: "Serves the model it claims and bills what it serves.", expect: "A, or C if the upstream gives no TEE signature",
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
  overclaim: {
    model: "z-ai/glm-5.3-flash", mode: "overclaim", ask: ["0.025", "0.10"],
    title: "Overclaim", blurb: "Bills the grader honestly, then claims 3x the tokens it served you.", expect: "passes grading; your receipts catch it and its bond is slashed",
  },
  deepseek: {
    model: "deepseek/deepseek-v4.1-flash", mode: "honest", ask: ["0.03", "0.12"],
    title: "Honest, no TEE", blurb: "An honest seller of a model without TEE signatures.", expect: "B",
  },
};

/** Personas a visitor may launch on the live server. */
export const LAUNCHABLE = ["honest", "swap", "sibling", "inflate", "overclaim"];

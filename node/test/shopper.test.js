import { test } from "node:test";
import assert from "node:assert/strict";
import { planVisit, pageBody, clientOptions } from "../src/shopper.js";

test("a visit looks like the live page: same body shape and options", () => {
  const p = planVisit("Qwen/Qwen3.8-27B", { seed: 7, maxTokens: 2048 });
  for (const st of p.steps) {
    const keys = Object.keys(st.body);
    assert.ok(JSON.stringify(keys) === JSON.stringify(["model", "messages", "max_tokens", "chat_template_kwargs"]) || JSON.stringify(keys) === JSON.stringify(["model", "messages", "max_tokens"]));
    assert.equal(st.body.max_tokens, 2048);
  }
  assert.ok(p.fingerprint.some((b) => !("chat_template_kwargs" in b)), "at least one plain fingerprint request");
  assert.deepEqual(clientOptions("z-ai/glm-5.3-flash"), { reasoning_effort: "low" });
  assert.deepEqual(Object.keys(pageBody("deepseek/x", "hi", 1024)), ["model", "messages", "max_tokens"]);
});

test("a visit mixes 3 fingerprint and 4 task requests, starts with a fingerprint one, and pauses", () => {
  process.env.TS_SHOPPER_GAP_SEC = "20-90";
  const p = planVisit("z-ai/glm-5.3-flash", { seed: 99 });
  assert.equal(p.steps.length, 7);
  assert.equal(p.steps[0].kind, "fingerprint");
  assert.equal(p.steps.filter((s) => s.kind === "fingerprint").length, 3);
  assert.equal(p.gaps[0], 0);
  for (const g of p.gaps.slice(1)) assert.ok(g >= 20_000 && g <= 90_000, `gap ${g}`);
  assert.ok(p.deposit >= 0.03 && p.deposit <= 0.08);
  assert.ok(p.closeAfterMs >= 10 * 60_000 && p.closeAfterMs <= 40 * 60_000);
  assert.notDeepEqual(planVisit("z-ai/glm-5.3-flash", { seed: 100 }).steps.map((s) => s.body.messages[0].content), p.steps.map((s) => s.body.messages[0].content));
});

test("natural prompts carry no probe-style instructions", () => {
  for (let seed = 1; seed < 40; seed++) {
    for (const st of planVisit("Qwen/Qwen3.8-27B", { seed }).steps) {
      assert.doesNotMatch(st.body.messages[0].content, /Reply with only|Fingerprint:/);
    }
  }
});

test("task checks accept a chatty correct answer and refuse a wrong one", () => {
  const p = planVisit("Qwen/Qwen3.8-27B", { seed: 5 });
  const mul = p.tasks.find((t) => t.id === "multiply");
  const [a, b] = (mul.prompt.match(/\d+/g) || []).map(Number);
  assert.ok(mul.check(`Sure! ${a} × ${b} = ${(a * b).toLocaleString("en-US")}. So the total is **${(a * b).toLocaleString("en-US")}**.`));
  assert.ok(!mul.check(`The total is ${a * b + 1}.`));
  const sort = p.tasks.find((t) => t.id === "sort");
  const nums = (sort.prompt.match(/\d+/g) || []).map(Number);
  assert.ok(sort.check(`Here they are in order: ${[...nums].sort((x, y) => x - y).join(", ")}.`));
  assert.ok(!sort.check(`Here they are: ${nums.join(", ")}.`) || nums.join() === [...nums].sort((x, y) => x - y).join());
});

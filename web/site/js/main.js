// Credster landing page: motion, media and live chain data.
// Everything here is progressive: without JS (or GSAP) the page is complete and static.

import { initHero } from "./hero.js";
import { CONTRACT, listings, stats, near, sha256OfUrl, short } from "./chain.js";
import { capabilityTasks, randomSeed } from "./tasks.js";
import { guillocheURL, microtext } from "./ornaments.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const small = () => innerWidth < 760 || navigator.connection?.saveData === true;
const { gsap, ScrollTrigger, SplitText, Lenis } = window;
const motion = !reduced && !!gsap && !!ScrollTrigger;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

if (gsap) gsap.registerPlugin(...[ScrollTrigger, SplitText].filter(Boolean));

/* ---------------------------------------------------------------- hero */
(async function hero() {
  const section = $(".hero");
  const img = $(".hero-img", section);
  if (reduced) return;
  try {
    await img.decode();
    initHero({ section, canvas: $(".hero-gl", section), img });
  } catch (e) {
    console.warn("hero", e);
  }
})();

/* ---------------------------------------------------------------- smooth scroll */
let lenis;
if (motion && Lenis) {
  lenis = new Lenis({ lerp: 0.1, smoothWheel: true });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
}
document.addEventListener("click", (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a) return;
  const id = a.getAttribute("href");
  const target = id.length > 1 && document.getElementById(id.slice(1));
  if (!target) return;
  e.preventDefault();
  if (lenis) lenis.scrollTo(target, { offset: id === "#top" ? 0 : -8, duration: 1.4 });
  else target.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
  history.replaceState(null, "", id);
});

/* ---------------------------------------------------------------- nav */
(function nav() {
  const navEl = $("#nav");
  const bar = $(".nav-progress span");
  let lastY = scrollY;
  const onScroll = () => {
    const y = scrollY;
    navEl.classList.toggle("is-scrolled", y > 24);
    navEl.classList.toggle("is-hidden", y > 640 && y > lastY + 2);
    if (y < lastY - 2) navEl.classList.remove("is-hidden");
    lastY = y;
    const max = document.documentElement.scrollHeight - innerHeight;
    bar.style.transform = `scaleX(${max > 0 ? Math.min(1, y / max) : 0})`;
  };
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  const links = $$(".nav-links a");
  const io = new IntersectionObserver((ens) => {
    for (const en of ens) {
      if (!en.isIntersecting) continue;
      const id = en.target.id;
      for (const l of links) l.classList.toggle("is-active", l.getAttribute("href") === `#${id}` || (id === "marks" && l.getAttribute("href") === "#grading") || (id === "settle" && l.getAttribute("href") === "#trade") || (id === "flow" && l.getAttribute("href") === "#trade"));
    }
  }, { rootMargin: "-45% 0px -50% 0px" });
  $$("main > section[id]").forEach((s) => io.observe(s));
})();

/* ---------------------------------------------------------------- small helpers */
const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789§#%&+=/<>";
function scramble(el, text, duration = 0.8) {
  cancelAnimationFrame(el._scr);
  const t0 = performance.now();
  const n = text.length;
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / (duration * 1000));
    const head = p * (n + 8);
    let out = "";
    for (let i = 0; i < n; i++) {
      if (text[i] === " " || head - i > 8) out += text[i];
      else if (head > i) out += GLYPHS[(Math.random() * GLYPHS.length) | 0];
      else out += "\u2007";
    }
    el.textContent = p < 1 ? out : text;
    if (p < 1) el._scr = requestAnimationFrame(tick);
  };
  el._scr = requestAnimationFrame(tick);
}

function countTo(el, to, { decimals = 0, prefix = "", suffix = "", duration = 1.6, from = 0 } = {}) {
  const fmt = (v) => prefix + v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;
  if (!motion) { el.textContent = fmt(to); return; }
  const o = { v: from };
  gsap.to(o, { v: to, duration, ease: "power3.out", onUpdate: () => (el.textContent = fmt(o.v)) });
}

function strike(hm, card) {
  if (!hm) return;
  if (!motion) { hm.style.opacity = 1; return; }
  const tl = gsap.timeline();
  tl.fromTo(hm, { opacity: 0, scale: 2.4, rotate: -16 }, { opacity: 1, scale: 1, rotate: 0, duration: 0.42, ease: "power4.in" })
    .fromTo(hm, { filter: "brightness(2.2)" }, { filter: "brightness(1)", duration: 0.6, ease: "power2.out", clearProps: "filter" })
    .fromTo(card || hm, { x: 0 }, { x: 2, duration: 0.05, repeat: 3, yoyo: true, ease: "none", clearProps: "x" }, "<");
  return tl;
}

/* ---------------------------------------------------------------- reveals */
if (motion) {
  document.fonts.ready.then(() => {
    $$("[data-split]").forEach((el) => {
      if (!SplitText) return;
      SplitText.create(el, {
        type: "lines", mask: "lines", linesClass: "sl", autoSplit: true,
        onSplit: (self) => gsap.from(self.lines, { yPercent: 108, rotate: 1.5, duration: 1.25, stagger: 0.09, ease: "expo.out", scrollTrigger: { trigger: el, start: "top 86%", once: true } }),
      });
    });
    ScrollTrigger.refresh();
  });
  gsap.set("[data-fade]", { opacity: 0, y: 36 });
  ScrollTrigger.batch("[data-fade]", { start: "top 90%", once: true, onEnter: (els) => gsap.to(els, { opacity: 1, y: 0, duration: 1.15, stagger: 0.09, ease: "expo.out", clearProps: "transform,opacity" }) });
  $$("[data-scramble]").forEach((el) => {
    const text = el.textContent;
    el.setAttribute("aria-label", text);
    el.style.visibility = "hidden";
    ScrollTrigger.create({ trigger: el, start: "top 92%", once: true, onEnter: () => { el.style.visibility = ""; scramble(el, text, 0.9); } });
  });
}

/* ---------------------------------------------------------------- video */
function pickSrc(v) { return small() && v.dataset.srcSm ? v.dataset.srcSm : v.dataset.src; }
// setting src starts the load by itself; calling load() too would abort and restart it
function ensureSrc(v) { if (!v.getAttribute("src")) v.src = pickSrc(v); }
const playSafe = (v) => { const p = v.play(); if (p) p.catch(() => {}); };

// decorative loops: load near the viewport, play only while visible
const loopIO = new IntersectionObserver((ens) => {
  for (const en of ens) {
    const v = en.target;
    if (en.isIntersecting) { ensureSrc(v); playSafe(v); } else v.pause();
  }
}, { rootMargin: "120px 0px" });
if (!reduced) $$("video[data-loop]:not([data-stage])").forEach((v) => loopIO.observe(v));

// scrubbed clips: scroll position drives currentTime
function scrubVideo(v, { trigger, start, end, onProgress }) {
  if (reduced || !motion) {
    if (v.dataset.posterEnd) v.poster = v.dataset.posterEnd;
    onProgress?.(1);
    return;
  }
  const state = { p: 0, want: 0, ready: false };
  const near = new IntersectionObserver(([en]) => {
    if (!en.isIntersecting) return;
    near.disconnect();
    v.preload = "auto";
    ensureSrc(v);
    v.addEventListener("loadeddata", () => {
      state.ready = true;
      // iOS paints seeked frames only after one play() call
      const p = v.play();
      if (p) p.then(() => { v.pause(); seek(); }).catch(() => {});
      seek();
    }, { once: true });
  }, { rootMargin: "800px 0px" });
  near.observe(v);
  let pending = false;
  function seek() {
    if (!state.ready || pending || !v.duration) return;
    const t = Math.min(v.duration - 0.04, state.p * v.duration);
    if (Math.abs(v.currentTime - t) < 1 / 60) return;
    pending = true;
    v.currentTime = t;
  }
  v.addEventListener("seeked", () => { pending = false; seek(); });
  const proxy = { p: 0 };
  const to = gsap.quickTo(proxy, "p", { duration: 0.5, ease: "power2.out", onUpdate: () => { state.p = proxy.p; seek(); onProgress?.(proxy.p); } });
  ScrollTrigger.create({ trigger, start, end, onUpdate: (st) => to(st.progress) });
}

/* ---------------------------------------------------------------- §01 problem */
(function problem() {
  const tag = $(".model-tag");
  const k = $(".k", tag), v = $(".v", tag);
  let swapped = false;
  const setSwap = (on) => {
    if (on === swapped) return;
    swapped = on;
    k.textContent = on ? "served:" : '"model":';
    v.classList.toggle("is-bad", on);
    const text = on ? "Qwen/Qwen3.6-35B-A3B-FP8" : '"Qwen/Qwen3.8-27B"';
    if (motion) scramble(v, text, 0.7); else v.textContent = text;
  };
  const crackCard = $(".risk:first-child");
  scrubVideo($(".risk video[data-scrub]"), { trigger: crackCard, start: "top 80%", end: "center 38%", onProgress: (p) => setSwap(p > 0.62) });

  const meter = $(".meter");
  const rows = $$(".meter-row", meter);
  if (motion) {
    gsap.set($$("i", meter), { scaleX: 0 });
    ScrollTrigger.create({ trigger: meter, start: "top 88%", once: true, onEnter: () => {
      gsap.to($$("i", meter), { scaleX: 1, duration: 1.6, stagger: 0.25, ease: "expo.out" });
      rows.forEach((r, i) => setTimeout(() => countTo($("b", r), +$("b", r).dataset.countTo, { duration: 1.6 }), i * 250));
    } });
  }
})();

/* ---------------------------------------------------------------- §02 grading */
const CAPTIONS = [
  "The touchstone: a streak compared with reference needles.",
  "The seal: a signature only the enclave can make.",
  "Fresh dice: a new seed on every run.",
  "The hallmark: struck once the checks are in.",
];
(function stage() {
  const vids = $$(".stage-vid");
  const n = $("[data-stage-n]"), t = $("[data-stage-t]");
  let cur = 0, inView = false;
  // only the active clip loads and plays, and only while the stage is on screen
  const sync = () => vids.forEach((v, j) => {
    if (j === cur && inView && !reduced) { ensureSrc(v); playSafe(v); } else v.pause();
  });
  const set = (i) => {
    if (i === cur) return;
    cur = i;
    vids.forEach((v, j) => v.classList.toggle("is-on", j === i));
    n.textContent = String(i + 1).padStart(2, "0");
    if (motion) scramble(t, CAPTIONS[i], 0.6); else t.textContent = CAPTIONS[i];
    sync();
  };
  new IntersectionObserver(([en]) => { inView = en.isIntersecting; sync(); }, { rootMargin: "200px 0px" }).observe($(".steps-stage"));
  if (ScrollTrigger) $$(".step").forEach((step) => {
    const i = +step.dataset.step;
    ScrollTrigger.create({ trigger: step, start: "top 55%", end: "bottom 55%", onToggle: (st) => st.isActive && set(i) });
  });
})();

const FP = {
  honest: { ref: [117, 103, 110], obs: [117, 103, 110], ok: true, text: "Match. Claimed Qwen3.8-27B; the counts fit Qwen3.8-27B and its abliterated sibling." },
  swap: { ref: [117, 103, 110], obs: [75, 61, 68], ok: false, text: "Mismatch. Claimed Qwen3.8-27B, but the counts fit Qwen3.6-35B-A3B-FP8. Grade F." },
  inflate: { ref: [70, 63, 74], obs: [95, 85, 100], ok: false, text: "Scaled. Claimed glm-5.3-flash, and every count is 1.353× its reference: inflated billing. Grade F." },
};
(function fingerprint() {
  const panel = $("[data-fp]");
  const rows = $$(".fp-rows li", panel);
  const verdict = $("[data-fp-verdict]", panel);
  const show = (key) => {
    const c = FP[key];
    panel.classList.toggle("is-bad", !c.ok);
    rows.forEach((li, i) => {
      const [ref, obs] = $$(".bar", li);
      ref.style.setProperty("--w", `${(c.ref[i] / 130) * 100}%`);
      obs.style.setProperty("--w", `${(c.obs[i] / 130) * 100}%`);
      countTo($("b", ref), c.ref[i], { from: +$("b", ref).textContent || 0, duration: 0.8 });
      countTo($("b", obs), c.obs[i], { from: +$("b", obs).textContent || 0, duration: 0.8 });
    });
    verdict.className = `verdict ${c.ok ? "ok" : "bad"}`;
    verdict.textContent = c.text;
  };
  segmented(panel, "data-case", show);
  show("honest");
})();

const TEE = {
  honest: {
    model: "Qwen/Qwen3.8-27B", req: "88cf74a4218e9e98f1bdec1fcb4bf51651cdb6353fcce04e96c8c48ee9a9dbaf", res: "9030ec7a38a15c4dad1527aa2e6ddcba43e25ca20b8fc4b01ac3f5b1d656b0f7",
    addr: "0x835ab53d20294ef795906dff21ae4c045336aa26", ok: true,
    c: [["ok", "Signature recovers to <code>ADDR</code>"], ["ok", "Signed text names the claimed model and our exact bytes"], ["ok", "NEAR AI’s attestation report for <code>Qwen3.8-27B</code> lists this signer"]],
    verdict: "Verified. The claimed model answered inside a TEE.",
  },
  sibling: {
    model: "Qwen/Qwen3.8-27B-abliterated", req: "7b9bab0f10379bfac4e18c582ee9838cf6065aed83d5547b944861e23f7627c4", res: "81bdbc10b04db8891bba84f641ed47e886002a7175ec2f800d17ec3517220161",
    addr: "0x979121f480a3c974b80cb37b81423ddc37093474", ok: false,
    c: [["ok", "Signature recovers to <code>ADDR</code>"], ["bad", "Signed text names <code>Qwen3.8-27B-abliterated</code>, not the claimed model"], ["bad", "The report for <code>Qwen3.8-27B</code> lists <code>0x835a…aa26</code>; the abliterated model’s report lists this signer"]],
    verdict: "Contradicts. A valid signature from the abliterated model’s enclave is proof of substitution. Grade F.",
  },
};
(function tee() {
  const panel = $("[data-tee]");
  const lis = [$("[data-tee-c1]", panel), $("[data-tee-c2]", panel), $("[data-tee-c3]", panel)];
  const show = (key) => {
    const c = TEE[key];
    panel.classList.toggle("is-bad", !c.ok);
    const m = $("[data-tee-model]", panel), rq = $("[data-tee-req]", panel), rs = $("[data-tee-res]", panel);
    if (motion) { scramble(m, c.model, 0.6); scramble(rq, short(c.req, 8, 8), 0.6); scramble(rs, short(c.res, 8, 8), 0.6); }
    else { m.textContent = c.model; rq.textContent = short(c.req, 8, 8); rs.textContent = short(c.res, 8, 8); }
    rq.title = `sha256 of our request: ${c.req}`;
    rs.title = `sha256 of the response: ${c.res}`;
    c.c.forEach(([cls, html], i) => { lis[i].className = cls; lis[i].innerHTML = html.replace("ADDR", short(c.addr, 10, 8)); });
    const v = $("[data-tee-verdict]", panel);
    v.className = `verdict ${c.ok ? "ok" : "bad"}`;
    v.textContent = c.verdict;
    if (motion) gsap.from(lis, { opacity: 0, x: -8, duration: 0.5, stagger: 0.12, ease: "power2.out" });
  };
  segmented(panel, "data-case", show);
  show("honest");
})();

(function tasks() {
  const panel = $("[data-tasks]");
  const list = $("[data-task-list]", panel);
  const seedEl = $("[data-seed]", panel);
  const note = $("[data-task-note]", panel);
  $("[data-reseed]", panel).addEventListener("click", () => {
    const seed = randomSeed();
    panel.classList.add("is-rolled");
    if (motion) scramble(seedEl, String(seed), 0.5); else seedEl.textContent = String(seed);
    list.innerHTML = capabilityTasks(seed).map((t) => `<li><span class="t-q">${esc(t.q)}</span><span class="t-a">${esc(t.a)}</span></li>`).join("");
    note.textContent = "Generated in your browser with the grader’s own generator (node/src/probes.js). A seller can’t have cached these answers.";
    if (motion) gsap.from($$("li", list), { opacity: 0, y: 10, duration: 0.5, stagger: 0.07, ease: "power2.out" });
  });
})();

(function onChain() {
  const hash = $(".chain .hash");
  const hm = $(".chain .stamp");
  if (!motion) return;
  const full = hash.textContent;
  hash.textContent = "";
  gsap.set(hm, { opacity: 0 });
  ScrollTrigger.create({ trigger: hash, start: "top 80%", once: true, onEnter: () => {
    hash.classList.add("is-typing");
    const o = { n: 0 };
    gsap.to(o, { n: full.length, duration: 1.3, ease: "none", onUpdate: () => (hash.textContent = full.slice(0, Math.round(o.n))), onComplete: () => { hash.classList.remove("is-typing"); strike(hm, hm.closest(".panel")); } });
  } });
})();

function segmented(scope, attr, onChange) {
  const btns = $$(`.seg [${attr}]`, scope);
  btns.forEach((b) => b.addEventListener("click", () => {
    if (b.getAttribute("aria-pressed") === "true") return;
    btns.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    onChange(b.getAttribute(attr));
  }));
}

/* ---------------------------------------------------------------- §04 the run */
(function run() {
  const track = $(".certs-track");
  const list = $("[data-certs]");
  const certs = $$(".cert", list);
  const bg = guillocheURL();
  certs.forEach((c) => {
    c.style.setProperty("--guilloche", bg);
    $(".cert-head", c).after(microtext(`CREDSTER ASSAY · LISTING ${c.dataset.listing} · REPORT SHA256 ${c.dataset.hash.toUpperCase()}`, 3));
  });

  const stampCert = (c) => { if (c._stamped) return; c._stamped = true; strike($(".stamp", c), c); };
  if (!motion) return;
  gsap.set($$(".stamp", list), { opacity: 0 });

  const mm = gsap.matchMedia();
  mm.add("(min-width: 1024px)", () => {
    const dist = () => Math.max(0, list.scrollWidth - innerWidth);
    const tween = gsap.to(list, {
      x: () => -dist(), ease: "none",
      scrollTrigger: { trigger: track, start: "center 52%", end: () => `+=${dist()}`, pin: true, scrub: 0.9, invalidateOnRefresh: true, anticipatePin: 1 },
    });
    certs.forEach((c) => ScrollTrigger.create({ trigger: c, containerAnimation: tween, start: "left 72%", onEnter: () => stampCert(c) }));
    return () => {};
  });
  mm.add("(max-width: 1023px)", () => {
    track.classList.add("is-swipe");
    const io = new IntersectionObserver((ens) => ens.forEach((en) => en.isIntersecting && stampCert(en.target)), { root: track, threshold: 0.6 });
    const vio = new IntersectionObserver(([en]) => { if (en.isIntersecting) certs.forEach((c) => io.observe(c)); });
    vio.observe(track);
    return () => { track.classList.remove("is-swipe"); io.disconnect(); vio.disconnect(); };
  });
})();

// one listing's report: hash it here, compare with the chain (or with the run log if RPC is down)
async function verifyListing(id, reportUrl, fallbackHash) {
  let chainHash = null, source = "chain";
  try {
    const l = (await listings()).find((x) => x.id === String(id));
    chainHash = l?.grade?.report_hash || null;
    reportUrl = l?.grade?.report_url || reportUrl;
  } catch { source = "run log"; }
  const expected = chainHash || fallbackHash;
  if (!chainHash) source = "run log";
  const got = await sha256OfUrl(reportUrl);
  return { ok: got === expected, got, expected, source };
}

$$("[data-verify]").forEach((btn) => btn.addEventListener("click", async () => {
  const c = btn.closest(".cert");
  const label = $(".v-label", btn), hash = $(".v-hash", btn);
  btn.className = "verify-btn is-busy";
  label.textContent = "Hashing report…";
  try {
    const r = await verifyListing(c.dataset.listing, c.dataset.report, c.dataset.hash);
    btn.className = `verify-btn ${r.ok ? "is-ok" : "is-bad"}`;
    label.innerHTML = r.ok ? `<i class="ico ico-ok"></i>Matches the ${esc(r.source)}` : `<i class="ico ico-x"></i>Differs from the ${esc(r.source)}`;
    hash.textContent = short(r.got, 8, 8);
    btn.title = `sha256 computed in your browser: ${r.got}\nexpected (${r.source}): ${r.expected}`;
  } catch (e) {
    btn.className = "verify-btn is-bad";
    label.textContent = "Couldn’t fetch the report";
    btn.title = String(e.message || e);
  }
}));

/* ---------------------------------------------------------------- §05 trading */
const OFFERS = [
  {
    title: "Offer #0 · listing #6 (A) · Bob · budget 0.08 NEAR", status: ["Accepted · order 16", "ok"],
    moves: [
      { by: "Buyer", pin: "0.0634", pout: "0.2376", note: "Tier A listing. My plan is 0.2970 NEAR per 1M output; opening at 0.2376 for a 0.08 NEAR budget." },
      { by: "Seller", pin: "0.0757", pout: "0.2838", note: "Graded A (TEE-attested), p50 2738 ms. I can meet you at 0.2838 per 1M output." },
    ],
    end: ["Bob accepted · negotiated order at 0.2838", "ok"],
  },
  {
    title: "Offer #1 · listing #10 (B) · Alice · budget 0.03 NEAR", status: ["Withdrawn · refunded", "warn"],
    moves: [
      { by: "Buyer", pin: "0.0192", pout: "0.1920", note: "Tier B listing. My plan is 0.2400 NEAR per 1M output; opening at 0.1920 for a 0.03 NEAR budget." },
      { by: "Seller", pin: "0.0255", pout: "0.2550", note: "Graded B (not attested), p50 1923 ms. I can meet you at 0.2550 per 1M output." },
      { by: "Buyer", pin: "0.0240", pout: "0.2400", note: "Your 0.2550 is above my plan. I can pay 0.2400 per 1M output, 80% of ask, for this tier. Final from me." },
      { by: "Seller", pin: "0.0255", pout: "0.2550", note: "Graded B (not attested), p50 1923 ms. I can meet you at 0.2550 per 1M output." },
    ],
    end: ["Alice walked away · 0.03 NEAR deposit refunded", "warn"],
  },
];

const chat = (function () {
  const box = $("[data-chat]");
  const log = $("[data-chat-log]", box);
  let run = 0;
  const msgHTML = (m) => `<li class="msg ${m.by}"><div class="msg-top"><span class="who">${m.by === "Buyer" ? "Buyer agent" : "Seller agent"}</span><span class="px">${m.pout} <small>out · ${m.pin} in</small></span></div><p class="note">${esc(m.note)}</p></li>`;
  async function play(i) {
    const id = ++run;
    const o = OFFERS[i];
    $("[data-chat-title]", box).textContent = o.title;
    const st = $("[data-chat-status]", box);
    st.textContent = o.status[0];
    st.className = `pill ${o.status[1]}`;
    log.innerHTML = "";
    const items = [...o.moves.map(msgHTML), `<li class="msg-end ${o.end[1]}">${esc(o.end[0])}</li>`];
    for (const html of items) {
      if (motion) await new Promise((r) => setTimeout(r, 650));
      if (id !== run) return;
      log.insertAdjacentHTML("beforeend", html);
      if (motion) gsap.from(log.lastElementChild, { opacity: 0, y: 14, scale: 0.98, duration: 0.6, ease: "expo.out" });
    }
  }
  segmented($("#pane-bargain"), "data-offer", (i) => play(+i));
  return { play };
})();

function drawChart(fig) {
  if (!fig || !motion) return;
  const lines = $$(".ln", fig);
  lines.forEach((p) => { const L = p.getTotalLength(); gsap.fromTo(p, { strokeDasharray: `${L} ${L}`, strokeDashoffset: L }, { strokeDashoffset: 0, duration: 1.6, ease: "power3.inOut", onComplete: () => { p.style.strokeDasharray = ""; p.style.strokeDashoffset = ""; } }); });
  gsap.fromTo($$(".pt, .tag", fig), { opacity: 0 }, { opacity: 1, duration: 0.6, stagger: 0.12, delay: 0.7, ease: "power2.out" });
}

(function tabs() {
  const tabs = $$(".mode");
  const ink = $(".modes-ink");
  const placeInk = (t) => { ink.style.width = `${t.offsetWidth}px`; ink.style.transform = `translateX(${t.offsetLeft}px)`; };
  const select = (t, focus) => {
    tabs.forEach((x) => {
      const on = x === t;
      x.setAttribute("aria-selected", String(on));
      x.tabIndex = on ? 0 : -1;
      $(`#${x.getAttribute("aria-controls")}`).hidden = !on;
    });
    if (focus) t.focus();
    placeInk(t);
    const pane = $(`#${t.getAttribute("aria-controls")}`);
    if (pane.id === "pane-bargain") chat.play(+($('[data-offer][aria-pressed="true"]', pane)?.dataset.offer || 0));
    else drawChart($(".chart", pane));
    if (motion) gsap.from($(".pane-text", pane).children, { opacity: 0, y: 14, duration: 0.6, stagger: 0.06, ease: "power2.out" });
    ScrollTrigger?.refresh();
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => select(t));
    t.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (d) { e.preventDefault(); select(tabs[(i + d + tabs.length) % tabs.length], true); }
    });
  });
  addEventListener("resize", () => placeInk(tabs.find((t) => t.getAttribute("aria-selected") === "true")));
  document.fonts.ready.then(() => placeInk(tabs[0]));
  placeInk(tabs[0]);
  if (motion) {
    gsap.set($$("#pane-spot .ln"), { opacity: 0 });
    ScrollTrigger.create({ trigger: ".modes", start: "top 75%", once: true, onEnter: () => { gsap.set($$("#pane-spot .ln"), { opacity: 1 }); drawChart($("#pane-spot .chart")); } });
  }
})();

/* ---------------------------------------------------------------- §06 settlement */
(function settle() {
  const steps = $$(".s-step");
  const bond = $(".bond"), bondV = $("[data-bond]");
  let slashed = false;
  const setSlash = (on) => {
    if (on === slashed) return;
    slashed = on;
    bond.classList.toggle("is-slashed", on);
    countTo(bondV, on ? 0.19 : 0.2, { decimals: 3, from: on ? 0.2 : 0.19, duration: 0.9 });
  };
  scrubVideo($(".settle video[data-scrub]"), { trigger: steps[3], start: "top 60%", end: () => `bottom+=${steps[4].offsetHeight * 0.4} 60%`, onProgress: (p) => setSlash(p > 0.82) });
  if (!motion) return;
  steps.forEach((s) => {
    gsap.set(s, { opacity: 0.28 });
    ScrollTrigger.create({ trigger: s, start: "top 62%", end: "bottom 38%", onToggle: (st) => gsap.to(s, { opacity: st.isActive ? 1 : 0.28, duration: 0.5, overwrite: true }) });
  });
  $$("[data-count-to]", $(".settle-totals")).forEach((el) => ScrollTrigger.create({ trigger: el, start: "top 90%", once: true, onEnter: () => countTo(el, +el.dataset.countTo, { duration: 1.2 }) }));
})();

/* ---------------------------------------------------------------- §07 sequence diagram */
const LANES = [["Seller node", "seller-node.js"], ["Contract", "market.credster…"], ["Grader", "grader.js"], ["Buyer", "buyer.js"], ["NEAR AI Cloud", "upstream + TEE"]];
const S = 0, C = 1, G = 2, B = 3, N = 4;
const SEQ = [
  ["Listing", [[S, C, "create_listing + bond"]]],
  ["Grading", [[G, C, "buy_spot · trial order"], [G, S, "probes, signed with the order key"], [S, N, "forwards with the seller’s own key"], [N, S, "answer + TEE signature", 1], [S, G, "answer + node-signed receipt", 1], [G, N, "attestation report for the claimed model"], [G, C, "post_grade(tier, checks, sha256)"]]],
  ["Trading", [[B, C, "buy_spot · open_tab · make_offer"], [B, S, "requests signed with the order key"], [S, B, "answers + receipts", 1]]],
  ["Settlement", [[S, C, "submit_claim(tokens, hash)"], [B, C, "dispute_claim, if claims > receipts"], [G, S, "receipts behind the claim"], [G, C, "resolve_dispute: pay, or slash", 0, 1], [C, S, "payment after the window", 1], [C, B, "refund of the unspent deposit", 1]]],
];
(function sequence() {
  const svg = $(".seq-svg");
  const list = $("[data-seq-list]");
  const NS = "http://www.w3.org/2000/svg";
  const X = (i) => 120 + i * 240;
  const el = (tag, attrs, parent = svg) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.appendChild(e); return e; };
  const msgs = [];
  let y = 130;
  const phaseG = el("g", {});
  const lifeG = el("g", {});
  for (const [name, items] of SEQ) {
    const top = y - 26;
    const h = items.length * 40 + 18;
    el("rect", { class: "phase", x: 8, y: top, width: 1184, height: h, rx: 12 }, phaseG);
    el("text", { class: "phase-t", x: 22, y: top + 18 }, phaseG).textContent = name.toUpperCase();
    for (const [a, b, label, ret, slash] of items) { msgs.push({ a, b, label, ret, slash, y: y + 10 }); y += 40; }
    y += 30;
  }
  const H = y;
  svg.setAttribute("viewBox", `0 0 1200 ${H}`);
  LANES.forEach(([name, sub], i) => {
    el("line", { class: "life", x1: X(i), y1: 84, x2: X(i), y2: H - 10 }, lifeG);
    el("rect", { class: "lane-box", x: X(i) - 92, y: 18, width: 184, height: 62, rx: 12 });
    el("text", { class: "lane-name", x: X(i), y: 46, "text-anchor": "middle" }).textContent = name;
    el("text", { class: "lane-sub", x: X(i), y: 66, "text-anchor": "middle" }).textContent = sub;
  });
  const groups = msgs.map((m, k) => {
    const g = el("g", { class: "msg-g" });
    const x1 = X(m.a), x2 = X(m.b), dir = Math.sign(x2 - x1);
    const line = el("path", { class: `msg-l${m.ret ? " ret" : ""}${m.slash ? " slash" : ""}`, d: `M${x1 + dir * 6} ${m.y}H${x2 - dir * 10}` }, g);
    const head = el("path", { class: "msg-h", d: `M${x2 - dir * 2} ${m.y}l${-dir * 10} -5v10z`, style: `fill:${m.slash ? "var(--f)" : m.ret ? "var(--ink-3)" : "var(--gold)"}` }, g);
    const text = el("text", { class: "msg-t", x: (x1 + x2) / 2, y: m.y - 9, "text-anchor": "middle" }, g);
    text.textContent = m.label;
    const num = el("text", { class: "msg-n", x: x1 + dir * 8, y: m.y + 16, "text-anchor": dir > 0 ? "start" : "end" }, g);
    num.textContent = String(k + 1).padStart(2, "0");
    return { g, line, head, text, num };
  });
  svg.querySelectorAll(".msg-t").forEach((t) => { t.style.paintOrder = "stroke"; t.style.stroke = "#0d0f13"; t.style.strokeWidth = "6px"; t.style.strokeLinejoin = "round"; });
  list.innerHTML = msgs.map((m) => `<li><span class="who">${esc(LANES[m.a][0])}<svg aria-label="to"><use href="#i-arrow"/></svg>${esc(LANES[m.b][0])}</span><span class="what">${esc(m.label)}</span></li>`).join("");

  if (!motion) return;
  const tl = gsap.timeline({ scrollTrigger: { trigger: ".seq", start: "top 72%", end: "bottom 78%", scrub: 0.6 } });
  groups.forEach(({ line, head, text, num }) => {
    const L = line.getTotalLength();
    gsap.set(line, { strokeDasharray: `${L} ${L}`, strokeDashoffset: L });
    gsap.set([head, text, num], { opacity: 0 });
    tl.to(line, { strokeDashoffset: 0, duration: 1, ease: "none" })
      .to(head, { opacity: 1, duration: 0.2 }, "-=0.15")
      .to([text, num], { opacity: 1, duration: 0.5 }, "-=0.7");
  });
})();

/* ---------------------------------------------------------------- §08 verify all */
(function verifier() {
  const btn = $("[data-verify-all]");
  const list = $("[data-v-list]");
  const sum = $("[data-v-summary]");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Reading the contract…";
    list.innerHTML = "";
    sum.textContent = "";
    try {
      const ls = (await listings()).filter((l) => l.grade);
      btn.textContent = `Hashing ${ls.length} reports…`;
      let ok = 0;
      list.innerHTML = ls.map((l) => `<li data-id="${esc(l.id)}"><svg class="hm hm-${esc(l.grade.tier)}" viewBox="0 0 100 100" aria-label="Grade ${esc(l.grade.tier)}"><use href="#hm-${esc(l.grade.tier)}"/></svg><div class="v-main"><p class="v-model">#${esc(l.id)} · ${esc(l.model)} · ${esc(l.seller.split(".")[0])}</p><code class="v-hash">chain ${esc(short(l.grade.report_hash, 12, 12))}</code></div><span class="v-res wait">…</span></li>`).join("");
      await Promise.all(ls.map(async (l) => {
        const li = $(`li[data-id="${CSS.escape(l.id)}"]`, list);
        const res = $(".v-res", li);
        try {
          const got = await sha256OfUrl(l.grade.report_url);
          const match = got === l.grade.report_hash;
          ok += match;
          res.className = `v-res ${match ? "ok" : "bad"}`;
          res.innerHTML = match ? '<i class="ico ico-ok"></i>match' : '<i class="ico ico-x"></i>differs';
          $(".v-hash", li).textContent = `sha256 ${short(got, 12, 12)}`;
          $(".v-hash", li).title = `computed ${got}\non chain ${l.grade.report_hash}`;
        } catch (e) {
          res.className = "v-res bad";
          res.innerHTML = '<i class="ico ico-x"></i>missing';
        }
        if (motion) gsap.from(li, { backgroundColor: "rgba(217,180,90,.12)", duration: 1.2 });
      }));
      sum.textContent = `${ok} of ${ls.length} reports match the report_hash on ${CONTRACT}. Hashed in your browser just now.`;
      btn.textContent = "Verify again";
    } catch (e) {
      list.innerHTML = `<li class="v-empty">Couldn’t reach NEAR testnet RPC (${esc(e.message || e)}). The report files are in <code>web/reports/</code>; <code>node src/cli.js verify-reports</code> runs the same check.</li>`;
      btn.textContent = "Try again";
    }
    btn.disabled = false;
  });
})();

$$("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(b.dataset.copy); b.classList.add("is-done"); setTimeout(() => b.classList.remove("is-done"), 1400); } catch {}
}));

/* ---------------------------------------------------------------- live ticker */
(async function ticker() {
  const box = $(".ticker");
  const src = $("#tickSrc");
  const set = (k, v, opts) => { const el = $(`[data-stat="${k}"]`, box); if (el) countTo(el, v, opts); };
  try {
    const [st, ls] = await Promise.all([stats(), listings()]);
    const open = ls.filter((l) => l.status !== "Closed");
    set("open", open.length, { duration: 1 });
    set("suspended", open.filter((l) => l.grade?.tier === "F").length, { duration: 1 });
    set("orders", +st.orders, { duration: 1.2 });
    set("tokens", Number(st.tokens_settled), { duration: 1.6 });
    set("slashed", Number(near(st.slashed_total, 4)), { decimals: 4, suffix: " NEAR", duration: 1.4 });
    box.classList.add("is-live");
    src.innerHTML = `Live from <b>${esc(CONTRACT)}</b>`;
  } catch {
    src.innerHTML = `Snapshot of <b>${esc(CONTRACT)}</b>, 12 Nov 2026 (RPC unreachable)`;
  }
})();

/* ---------------------------------------------------------------- finale parallax */
if (motion) {
  gsap.fromTo(".finale-bg img", { scale: 1.15, yPercent: -4 }, { scale: 1, yPercent: 4, ease: "none", scrollTrigger: { trigger: ".finale", start: "top bottom", end: "bottom top", scrub: true } });
  gsap.fromTo(".marks-bg img", { scale: 1.12 }, { scale: 1, ease: "none", scrollTrigger: { trigger: ".marks", start: "top bottom", end: "bottom top", scrub: true } });
  $$(".risk-media, .stage-frame, .settle-frame").forEach((m) => gsap.fromTo(m, { clipPath: "inset(8% 6% 8% 6% round 26px)" }, { clipPath: "inset(0% 0% 0% 0% round 22px)", ease: "expo.out", duration: 1.6, scrollTrigger: { trigger: m, start: "top 88%", once: true } }));
  addEventListener("load", () => ScrollTrigger.refresh());
}

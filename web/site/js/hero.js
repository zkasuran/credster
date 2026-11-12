// Hero: the generated fingerprint photograph, relit in WebGL.
// A height field taken from the image's luminance gives each gold ridge a normal,
// so a moving light (and the pointer) makes the ridges glint. Dust drifts in the beam.

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uRes, uImg, uFocus, uLight, uShift;
uniform float uFade, uZoom;

float lum(vec2 p) { return dot(texture2D(uTex, p).rgb, vec3(0.299, 0.587, 0.114)); }

void main() {
  float sr = uRes.x / uRes.y, ir = uImg.x / uImg.y;
  vec2 s = sr > ir ? vec2(1.0, ir / sr) : vec2(sr / ir, 1.0);
  s /= uZoom;
  vec2 uv = (1.0 - s) * uFocus + vec2(vUv.x, 1.0 - vUv.y) * s + uShift;
  vec3 base = texture2D(uTex, uv).rgb;

  vec2 e = vec2(1.5) / uImg;
  float hl = lum(uv - vec2(e.x, 0.0)), hr = lum(uv + vec2(e.x, 0.0));
  float hu = lum(uv - vec2(0.0, e.y)), hd = lum(uv + vec2(0.0, e.y));
  vec3 n = normalize(vec3((hl - hr) * 5.0, (hd - hu) * 5.0, 1.0));

  vec2 dl = (uLight - vUv) * vec2(uRes.x / uRes.y, 1.0);
  vec3 L = normalize(vec3(dl, 0.42));
  float ndh = max(dot(n, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0);
  float spec = pow(ndh, 70.0) + 0.3 * pow(ndh, 16.0);
  float fall = exp(-dot(dl, dl) * 2.4);

  float l0 = dot(base, vec3(0.299, 0.587, 0.114));
  float goldMask = clamp((base.r - base.b) * 3.2, 0.0, 1.0) * smoothstep(0.05, 0.3, l0);
  vec3 gold = vec3(1.0, 0.79, 0.46);
  vec3 col = base * (0.8 + 0.3 * fall);
  col += gold * spec * goldMask * fall * 1.5;
  col += gold * 0.04 * fall * (0.5 + 0.5 * goldMask);

  vec2 q = vUv - vec2(0.56, 0.5);
  col *= 1.0 - dot(q, q) * 0.5;
  gl_FragColor = vec4(col * uFade, 1.0);
}`;

const PVERT = `
attribute vec4 aSeed;
uniform float uTime, uDpr, uFade;
uniform vec2 uLight;
varying float vA;
void main() {
  float sp = 0.006 + aSeed.z * 0.016;
  float y = fract(aSeed.y + uTime * sp);
  float x = fract(aSeed.x + 0.03 * sin(uTime * 0.2 + aSeed.w * 6.2831) + uTime * sp * 0.3);
  vec2 p = vec2(x, y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = (1.1 + aSeed.z * aSeed.z * 4.2) * uDpr;
  float edge = smoothstep(0.0, 0.12, y) * smoothstep(1.0, 0.86, y);
  float beam = smoothstep(1.0, 0.15, abs((p.x - 0.1) + (p.y - 0.95) * 0.8) * 1.5);
  vec2 dn = (uLight - p) * vec2(1.6, 1.0);
  float nearL = exp(-dot(dn, dn) * 6.0);
  float tw = 0.55 + 0.45 * sin(uTime * (0.6 + aSeed.w * 1.4) + aSeed.x * 30.0);
  vA = (0.12 + 0.55 * aSeed.z) * edge * (0.25 + beam * 0.6 + nearL * 0.9) * tw * uFade;
}`;

const PFRAG = `
precision mediump float;
varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.05, d) * vA;
  gl_FragColor = vec4(vec3(1.0, 0.84, 0.58) * a, a);
}`;

function program(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name;
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

const ease = (t) => 1 - Math.pow(1 - t, 3);

/**
 * Starts the relit hero. Returns false (and leaves the plain <img>) when WebGL
 * is unavailable. `img` must be the decoded hero image.
 */
export function initHero({ section, canvas, img }) {
  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "high-performance" });
  if (!gl) return false;
  let main, dust;
  try {
    main = program(gl, VERT, FRAG);
    dust = program(gl, PVERT, PFRAG);
  } catch (e) {
    console.warn("hero shader", e);
    return false;
  }

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const N = 110;
  const seeds = new Float32Array(N * 4).map(() => Math.random());
  const seedBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, seedBuf);
  gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
  const imgSize = [img.naturalWidth, img.naturalHeight];

  let dpr = 1, W = 1, H = 1;
  function resize() {
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    dpr = Math.min(window.devicePixelRatio || 1, W < 860 ? 1 : 1.5);
    const budget = 3.4e6; // pixels per frame
    if (W * H * dpr * dpr > budget) dpr = Math.sqrt(budget / (W * H));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  // light: an intro sweep from the beam's corner, then a slow drift; the pointer pulls it
  const light = [0.08, 0.92], shift = [0, 0], shiftT = [0, 0], ptr = [0.6, 0.5];
  let pull = 0, lastMove = -1e9;
  section.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    ptr[0] = (e.clientX - r.left) / r.width;
    ptr[1] = 1 - (e.clientY - r.top) / r.height;
    shiftT[0] = (ptr[0] - 0.5) * -0.012;
    shiftT[1] = (ptr[1] - 0.5) * 0.008;
    lastMove = performance.now();
  }, { passive: true });

  let running = false, raf = 0, t0 = performance.now(), visible = true, lost = false;
  const focus = () => [W < 860 ? 0.72 : 0.68, 0.5];

  function frame(now) {
    const t = (now - t0) / 1000;
    const intro = ease(Math.min(1, t / 3.2));
    const drift = [0.66 + 0.17 * Math.sin(t * 0.17), 0.5 + 0.16 * Math.sin(t * 0.11 + 1.3)];
    const auto = [0.08 + (drift[0] - 0.08) * intro, 0.92 + (drift[1] - 0.92) * intro];
    pull += ((now - lastMove < 2200 ? 1 : 0) - pull) * 0.04;
    const target = [auto[0] + (ptr[0] - auto[0]) * pull, auto[1] + (ptr[1] - auto[1]) * pull];
    light[0] += (target[0] - light[0]) * 0.08;
    light[1] += (target[1] - light[1]) * 0.08;
    shift[0] += (shiftT[0] - shift[0]) * 0.05;
    shift[1] += (shiftT[1] - shift[1]) * 0.05;
    const fade = Math.min(1, t / 1.2);

    gl.disable(gl.BLEND);
    gl.useProgram(main.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    const ap = gl.getAttribLocation(main.p, "aPos");
    gl.enableVertexAttribArray(ap);
    gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(main.u.uTex, 0);
    gl.uniform2f(main.u.uRes, W, H);
    gl.uniform2f(main.u.uImg, imgSize[0], imgSize[1]);
    gl.uniform2fv(main.u.uFocus, focus());
    gl.uniform2fv(main.u.uLight, light);
    gl.uniform2fv(main.u.uShift, shift);
    gl.uniform1f(main.u.uFade, fade);
    gl.uniform1f(main.u.uZoom, 1.03);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(ap);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(dust.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, seedBuf);
    const as = gl.getAttribLocation(dust.p, "aSeed");
    gl.enableVertexAttribArray(as);
    gl.vertexAttribPointer(as, 4, gl.FLOAT, false, 0, 0);
    gl.uniform1f(dust.u.uTime, t);
    gl.uniform1f(dust.u.uDpr, dpr);
    gl.uniform1f(dust.u.uFade, fade);
    gl.uniform2fv(dust.u.uLight, light);
    gl.drawArrays(gl.POINTS, 0, N);
    gl.disableVertexAttribArray(as);

    if (running) raf = requestAnimationFrame(frame);
  }

  const start = () => { if (!running && visible && !lost && !document.hidden) { running = true; raf = requestAnimationFrame(frame); } };
  const stop = () => { running = false; cancelAnimationFrame(raf); };
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; visible ? start() : stop(); }).observe(section);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); lost = true; stop(); section.classList.remove("gl-on"); });

  start();
  requestAnimationFrame(() => section.classList.add("gl-on"));
  return true;
}

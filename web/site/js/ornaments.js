// Security-print ornaments: guilloche rosettes (hypotrochoids) and microtext lines.

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/** SVG path for a hypotrochoid rosette centred on (cx, cy), scaled to `radius`. */
export function rosette({ R = 48, r = 17, d = 20, radius = 160, cx = 170, cy = 170, rot = 0, perTurn = 110 }) {
  const turns = r / gcd(R, r);
  const steps = Math.ceil(turns * perTurn);
  const k = (R - r) / r;
  const scale = radius / (R - r + d);
  let path = "";
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2 * turns;
    const x0 = (R - r) * Math.cos(t) + d * Math.cos(k * t);
    const y0 = (R - r) * Math.sin(t) - d * Math.sin(k * t);
    const x = cx + scale * (x0 * Math.cos(rot) - y0 * Math.sin(rot));
    const y = cy + scale * (x0 * Math.sin(rot) + y0 * Math.cos(rot));
    path += `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return path;
}

let cached;
/** A CSS url() holding a layered guilloche rosette, for card backgrounds. */
export function guillocheURL() {
  if (cached) return cached;
  const layers = [
    { R: 48, r: 17, d: 21, radius: 165, o: 0.5 },
    { R: 48, r: 17, d: 12, radius: 120, rot: 0.07, o: 0.4 },
    { R: 40, r: 13, d: 9, radius: 74, o: 0.45 },
  ];
  const paths = layers.map((l) => `<path d="${rosette(l)}" stroke-opacity="${l.o}"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 340"><g fill="none" stroke="#d9b45a" stroke-width=".45">${paths}<circle cx="170" cy="170" r="168" stroke-opacity=".35"/><circle cx="170" cy="170" r="171" stroke-opacity=".2"/></g></svg>`;
  cached = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  return cached;
}

/** A line of tiny repeated text, like the microprint on a banknote. */
export function microtext(text, repeat = 14) {
  const p = document.createElement("p");
  p.className = "micro";
  p.setAttribute("aria-hidden", "true");
  p.textContent = Array(repeat).fill(text).join(" · ");
  return p;
}

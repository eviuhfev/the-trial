// Hard Algebra 1-2 questions for turning focus off early. Every question is built from its answer, so the answer is exact.
// Used by background.js (importScripts) and by tests in Node.
(function (root) {
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const nz = (a, b) => { let n; do n = rnd(a, b); while (n === 0); return n; };
  const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a || 1; };
  const M = "−";   // minus sign

  // An exact fraction [num, den] with den > 0, reduced.
  const frac = (n, d) => { if (d < 0) { n = -n; d = -d; } const g = gcd(n, d); return [n / g, d / g]; };
  const showFrac = ([n, d]) => (n < 0 ? "-" : "") + (d === 1 ? Math.abs(n) : `${Math.abs(n)}/${d}`);
  const num = (n) => (n < 0 ? M + Math.abs(n) : String(n));

  // Terms [[coefficient, "x<sup>2</sup>"], ...] -> "3x<sup>2</sup> − x + 4", skipping zeros.
  function poly(terms) {
    let out = "";
    for (const [c, v] of terms) {
      if (c === 0) continue;
      const abs = Math.abs(c);
      const body = (abs === 1 && v ? "" : abs) + v;
      out += out ? (c < 0 ? ` ${M} ` : " + ") + body : (c < 0 ? M : "") + body;
    }
    return out || "0";
  }
  const X2 = "x<sup>2</sup>", X3 = "x<sup>3</sup>";

  const MAKERS = {
    // (a1·x − b1)(a2·x − b2) = 0, expanded: rational roots, leading coefficient > 1.
    quadratic() {
      let a1, a2, b1, b2;
      do { a1 = rnd(1, 5); a2 = rnd(2, 5); b1 = nz(-9, 9); b2 = nz(-9, 9); } while (b1 * a2 === b2 * a1 || gcd(a1, b1) !== 1 || gcd(a2, b2) !== 1);
      let A = a1 * a2, B = -(a1 * b2 + a2 * b1), C = b1 * b2;
      const g = gcd(gcd(A, B), C); A /= g; B /= g; C /= g;
      return {
        html: `Solve for x: ${poly([[A, X2], [B, "x"], [C, ""]])} = 0`,
        prompt: "Enter both solutions, with a comma between them. Fractions like 3/2 are fine.",
        answers: [frac(b1, a1), frac(b2, a2)], ordered: false,
      };
    },
    // Two equations, two unknowns, integer solution.
    system() {
      let a, b, c, d;
      const x = nz(-8, 8), y = nz(-8, 8);
      do { a = nz(-7, 7); b = nz(-7, 7); c = nz(-7, 7); d = nz(-7, 7); } while (Math.abs(a * d - b * c) < 2 || Math.abs(a) === Math.abs(c));
      const e1 = a * x + b * y, e2 = c * x + d * y;
      return {
        html: `Solve the system:<br>${poly([[a, "x"], [b, "y"]])} = ${num(e1)}<br>${poly([[c, "x"], [d, "y"]])} = ${num(e2)}`,
        prompt: "Enter x and y in that order, like 3, -2.",
        answers: [frac(x, 1), frac(y, 1)], ordered: true,
      };
    },
    // b^(p·x + q) = (b^k)^(r·x + s), integer solution.
    exponent() {
      const b = pick([2, 3, 5]), k = b === 5 ? 2 : pick([2, 3]);
      let p, r, x, s, q;
      do { p = rnd(1, 6); r = rnd(1, 3); x = nz(-6, 6); s = rnd(-4, 4); q = k * s - x * (p - k * r); } while (p === k * r || q === 0 || Math.abs(q) > 20);
      return {
        html: `Solve for x: ${b}<sup>${poly([[p, "x"], [q, ""]])}</sup> = ${b ** k}<sup>${poly([[r, "x"], [s, ""]])}</sup>`,
        prompt: "Enter the value of x.",
        answers: [frac(x, 1)], ordered: false,
      };
    },
    // log_b(x) + log_b(x − k) = n, with an extraneous negative root.
    log() {
      const base = pick([2, 2, 3]);
      const a = base === 2 ? rnd(2, 5) : rnd(2, 3), bb = rnd(0, a - 1);
      const x0 = base ** a, k = base ** a - base ** bb, n = a + bb;
      return {
        html: `Solve for x: log<sub>${base}</sub>(x) + log<sub>${base}</sub>(x ${M} ${k}) = ${n}`,
        prompt: "Enter every solution that works (a comma between them if there is more than one).",
        answers: [frac(x0, 1)], ordered: false,
      };
    },
    // √(a·x + b) = x − c, often with an extraneous root.
    radical() {
      let a, b, c, r, r2;
      do { c = rnd(-3, 4); r = c + rnd(1, 7); a = rnd(1, 8); b = (r - c) ** 2 - a * r; r2 = 2 * c + a - r; } while (b === 0 || Math.abs(b) > 40);
      const answers = [frac(r, 1)];
      if (r2 !== r && r2 - c >= 0) answers.push(frac(r2, 1));
      return {
        html: `Solve for x: √(${poly([[a, "x"], [b, ""]])}) = ${poly([[1, "x"], [-c, ""]])}`,
        prompt: "Enter every solution that works (a comma between them if there is more than one).",
        answers, ordered: false,
      };
    },
    // |a·x + b| = c·x + d
    absolute() {
      for (;;) {
        const a = rnd(2, 6), c = nz(-3, 4), b = nz(-9, 9), d = rnd(-6, 9);
        if (a === c || a === -c) continue;
        const sols = [frac(d - b, a - c), frac(-d - b, a + c)]
          .filter(([n, den]) => c * n + d * den >= 0)   // right side can't be negative
          .filter((f, i, l) => l.findIndex((g) => g[0] === f[0] && g[1] === f[1]) === i);
        if (!sols.length || sols.some(([, den]) => den > 9)) continue;
        return {
          html: `Solve for x: |${poly([[a, "x"], [b, ""]])}| = ${poly([[c, "x"], [d, ""]])}`,
          prompt: "Enter every solution that works (a comma between them if there is more than one). Fractions like 3/2 are fine.",
          answers: sols, ordered: false,
        };
      }
    },
    // Minimum of a·x² + b·x + c, a > 0.
    vertex() {
      const a = rnd(1, 4), h = nz(-6, 6), k = rnd(-20, 20);
      return {
        html: `What is the minimum value of f(x) = ${poly([[a, X2], [-2 * a * h, "x"], [a * h * h + k, ""]])}?`,
        prompt: "Enter the minimum value of f(x).",
        answers: [frac(k, 1)], ordered: false,
      };
    },
    // Geometric sequence from two terms.
    geometric() {
      const a1 = nz(-4, 4), r = pick([-3, -2, 2, 3]);
      return {
        html: `In a geometric sequence, the 2nd term is ${num(a1 * r)} and the 5th term is ${num(a1 * r ** 4)}. What is the 7th term?`,
        prompt: "Enter the 7th term.",
        answers: [frac(a1 * r ** 6, 1)], ordered: false,
      };
    },
    // Remainder theorem.
    remainder() {
      const b = rnd(-9, 9), c = rnd(-9, 9), d = nz(-9, 9), t = nz(-3, 3);
      return {
        html: `What is the remainder when ${poly([[1, X3], [b, X2], [c, "x"], [d, ""]])} is divided by (${poly([[1, "x"], [-t, ""]])})?`,
        prompt: "Enter the remainder.",
        answers: [frac(t ** 3 + b * t * t + c * t + d, 1)], ordered: false,
      };
    },
    // (a + bi)(c + di) in a + bi form.
    complex() {
      const a = nz(-6, 6), b = nz(-6, 6), c = nz(-6, 6), d = nz(-6, 6);
      const z = (p, q) => (q < 0 ? `${num(p)} ${M} ${Math.abs(q) === 1 ? "" : Math.abs(q)}i` : `${num(p)} + ${q === 1 ? "" : q}i`);
      return {
        html: `Write (${z(a, b)})(${z(c, d)}) in the form a + bi.`,
        prompt: "Enter a and b in that order, like 7, -4.",
        answers: [frac(a * c - b * d, 1), frac(a * d + b * c, 1)], ordered: true,
      };
    },
  };

  function makeQuestion(kind) {
    kind = MAKERS[kind] ? kind : pick(Object.keys(MAKERS));
    const q = MAKERS[kind]();
    return { kind, ...q, show: q.answers.map(showFrac).join(", ") };
  }

  // "x = 3/2, -1", "(2, −5)", "1.5 and -1" -> [1.5, -1]
  function parseNumbers(text) {
    const s = String(text || "").replace(/[−–—]/g, "-").replace(/\s+/g, "");
    const out = [];
    for (const m of s.matchAll(/-?\d*\.?\d+(?:\/-?\d*\.?\d+)?/g)) {
      const [n, d] = m[0].split("/");
      const v = d === undefined ? Number(n) : Number(n) / Number(d);
      if (Number.isFinite(v)) out.push(v);
    }
    return out;
  }

  function checkAnswer(q, text) {
    // One answer: "2,187" is a thousands separator, not two numbers.
    if (q.answers.length === 1) text = String(text || "").replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
    const got = parseNumbers(text);
    const want = q.answers.map(([n, d]) => n / d);
    if (got.length !== want.length) return false;
    const close = (g, w) => Math.abs(g - w) < (Number.isInteger(w) ? 1e-9 : 0.006);
    if (q.ordered) return want.every((w, i) => close(got[i], w));
    // Unordered: match each expected value to a different entry.
    const left = got.slice();
    return want.every((w) => { const i = left.findIndex((g) => close(g, w)); if (i < 0) return false; left.splice(i, 1); return true; });
  }

  const api = { makeQuestion, checkAnswer, parseNumbers, kinds: Object.keys(MAKERS) };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BoonAlgebra = api;
})(typeof self !== "undefined" ? self : globalThis);

#!/usr/bin/env node
"use strict";

/**
 * CA vs Intention-Space (perception-driven) — Node CLI
 * ASCII: node cpux_ca_is_cli.js ascii
 *  Images: node cpux_ca_is_cli.js pgm (writes out_classI_ca.pgm, out_classI_is.pgm, …)
 * Outputs:
 *  - ASCII in terminal, or
 *  - PGM images (portable graymap) that you can insert into papers.
 *
 * Intention-Space adds:
 *  - CPI (Contextual Pulse Injection): pattern-triggered override to 1
 *  - Reflection: after a cell stays 1 for 'reflectionHold' steps, it nudges a neighbor
 *  - Random injection: low-rate novelty seeds
 */

// -------------------- presets (Class I–IV) --------------------
// “Better looking” Class I: use rule 255 with random init -> collapses to solid black (visible convergence).
// If you prefer convergence to white: use rule 0 with random init -> collapses to blank.
const PRESETS = [
  {
    key: "classI",
    title: "Class I — Convergence",
    rule: 255,
    init: "random",
    steps: 120,
    size: 141,
    // IS knobs (kept minimal so it still “converges” but can show sparse deviations if desired)
    cpiPatterns: [],          // keep empty for “pure class I”
    injectProb: 0.0,
    reflectionHold: 999,
  },
  {
    key: "classII",
    title: "Class II — Periodic",
    rule: 4,
    init: "single",
    steps: 120,
    size: 141,
    cpiPatterns: ["101"],     // small, rare “defect injector”
    injectProb: 0.002,
    reflectionHold: 6,
  },
  {
    key: "classIII",
    title: "Class III — Chaotic",
    rule: 30,
    init: "random",
    steps: 120,
    size: 141,
    cpiPatterns: ["101", "010", "001"], // encourage extra activity
    injectProb: 0.02,
    reflectionHold: 2,
  },
  {
    key: "classIV",
    title: "Class IV — Emergent",
    rule: 110,
    init: "single",
    steps: 120,
    size: 141,
    cpiPatterns: ["101", "100"], // typical “structured pushes”
    injectProb: 0.01,
    reflectionHold: 4,
  },
];

// -------------------- core CA --------------------
function ruleFn(ruleNumber) {
  return (l, c, r) => (ruleNumber >> ((l << 2) | (c << 1) | r)) & 1;
}

function initRow(size, mode) {
  const row = new Array(size).fill(0);
  if (mode === "single") row[Math.floor(size / 2)] = 1;
  else {
    // sparse random seed
    for (let i = 0; i < size; i++) row[i] = Math.random() < 0.1 ? 1 : 0;
  }
  return row;
}

function runCA({ rule, size, steps, init }) {
  const f = ruleFn(rule);
  const grid = Array.from({ length: steps }, () => new Array(size).fill(0));
  grid[0] = initRow(size, init);

  for (let t = 1; t < steps; t++) {
    const prev = grid[t - 1];
    const next = grid[t];
    for (let i = 0; i < size; i++) {
      const l = prev[(i - 1 + size) % size];
      const c = prev[i];
      const r = prev[(i + 1) % size];
      next[i] = f(l, c, r);
    }
  }
  return grid;
}

// -------------------- Intention Space variant --------------------
/**
 * CPI: Contextual Pulse Injection
 * Here it is a simple pattern-trigger rule: if neighborhood matches one of cpiPatterns, propose pulse=1.
 * In an LLM version, CPI would be a model that proposes pulses based on broader context.
 */
function cpiPropose(l, c, r, cpiPatterns) {
  if (!cpiPatterns || cpiPatterns.length === 0) return 0;
  const pat = `${l}${c}${r}`;
  return cpiPatterns.includes(pat) ? 1 : 0;
}

function runISVariant({ rule, size, steps, init, cpiPatterns, injectProb, reflectionHold }) {
  const f = ruleFn(rule);
  const grid = Array.from({ length: steps }, () => new Array(size).fill(0));
  const consecOnes = new Array(size).fill(0);

  grid[0] = initRow(size, init);

  for (let t = 1; t < steps; t++) {
    const prev = grid[t - 1];
    const next = grid[t];

    // phase A: compute proposals and reflections from prev
    const proposal = new Array(size).fill(0);
    const reflection = new Array(size).fill(0);

    for (let i = 0; i < size; i++) {
      const l = prev[(i - 1 + size) % size];
      const c = prev[i];
      const r = prev[(i + 1) % size];

      // CPI pattern-trigger proposal
      if (cpiPropose(l, c, r, cpiPatterns)) proposal[i] = 1;

      // random novelty injection
      if (Math.random() < injectProb) proposal[i] = 1;

      // track persistence for reflection
      consecOnes[i] = c ? consecOnes[i] + 1 : 0;

      // reflection: after hold threshold, nudge a neighbor
      if (consecOnes[i] >= reflectionHold) {
        const dir = (i % 2 === 0) ? 1 : -1; // simple alternating direction
        reflection[(i + dir + size) % size] = 1;
      }
    }

    // phase B: produce next state: base CA unless overridden by proposal/reflection
    for (let i = 0; i < size; i++) {
      if (proposal[i] || reflection[i]) next[i] = 1;
      else {
        const l = prev[(i - 1 + size) % size];
        const c = prev[i];
        const r = prev[(i + 1) % size];
        next[i] = f(l, c, r);
      }
    }
  }

  return grid;
}

// -------------------- outputs --------------------
function toASCII(grid) {
  // Use full block for 1, space for 0
  return grid.map(row => row.map(v => (v ? "█" : " ")).join("")).join("\n");
}

function toPGM(grid) {
  // P2 ASCII PGM: 0=black, 255=white; we invert so 1 appears black like CA plots.
  const h = grid.length, w = grid[0].length;
  let out = `P2\n${w} ${h}\n255\n`;
  for (let y = 0; y < h; y++) {
    const row = grid[y].map(v => (v ? 0 : 255)).join(" ");
    out += row + "\n";
  }
  return out;
}

// -------------------- main --------------------
const mode = (process.argv[2] || "ascii").toLowerCase();
const fs = require("fs");

for (const p of PRESETS) {
  const ca = runCA(p);
  const is = runISVariant(p);

  if (mode === "ascii") {
    console.log("\n=== " + p.title + " ===");
    console.log("CA (left idea):");
    console.log(toASCII(ca));
    console.log("\nIS (right idea):");
    console.log(toASCII(is));
  } else if (mode === "pgm") {
    fs.writeFileSync(`out_${p.key}_ca.pgm`, toPGM(ca), "utf8");
    fs.writeFileSync(`out_${p.key}_is.pgm`, toPGM(is), "utf8");
    console.log(`wrote out_${p.key}_ca.pgm and out_${p.key}_is.pgm`);
  } else {
    console.error("Usage: node cpux_ca_is_cli.js [ascii|pgm]");
    process.exit(1);
  }
}

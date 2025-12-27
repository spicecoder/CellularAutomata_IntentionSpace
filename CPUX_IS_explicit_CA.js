'use strict';

/**
 * CPUX-style CA vs Intention-Space variant
 * - Pulses are immutable: appended to pulseLedger, never edited.
 * - Field snapshots are derived per pass from base-rule + injected pulses.
 */

/** ---------- Low-level CA rule ---------- */
function ruleFn(ruleNumber) {
  return (l, c, r) => {
    const idx = (l << 2) | (c << 1) | r; // 0..7
    return (ruleNumber >> idx) & 1;
  };
}

function initRow(size, initMode, rng = Math.random) {
  const row = new Array(size).fill(0);
  if (initMode === 'single') row[Math.floor(size / 2)] = 1;
  else if (initMode === 'random') {
    for (let i = 0; i < size; i++) row[i] = rng() < 0.1 ? 1 : 0;
  }
  return row;
}

function neighborhood3(prev, i) {
  const n = prev.length;
  const l = prev[(i - 1 + n) % n];
  const c = prev[i];
  const r = prev[(i + 1) % n];
  return { l, c, r, nb: `${l}${c}${r}` };
}

/** ---------- Pulse / Intention / Ledger ---------- */
/**
 * Pulse: immutable record. We don't store "cell value changes"; we store "nudges" or "assertions"
 * that will be absorbed into the next snapshot.
 */
function makePulse({ passIndex, targetIndex, pulseKind, sourceDN, details }) {
  return Object.freeze({
    passIndex,
    targetIndex,
    pulseKind,   // 'proposal' | 'reflection' | 'novelty'
    sourceDN,    // 'DN_CPI' | 'DN_REFLECT'
    details: details || {},
    createdAt: new Date().toISOString(),
  });
}

/** Intention: carries one pulse (in this simplified demo) */
function makeIntention({ fromDN, toObject, pulse }) {
  return Object.freeze({
    fromDN,
    toObject,
    pulse,
  });
}

/** ---------- CPUX Components ---------- */
function makeVisitor() {
  return {
    fieldSnapshot: null,          // the snapshot being carried this pass
    incomingIntentions: [],       // intentions produced during this pass (to be absorbed)
  };
}

function makeGatekeeper() {
  return {
    /**
     * Gatekeeper absorbs intentions into an append-only pulse ledger.
     * No pulse is mutated; ledger is only appended.
     */
    absorbIntentionsIntoLedger({ visitor, pulseLedger }) {
      for (const I of visitor.incomingIntentions) {
        pulseLedger.push(I.pulse);
      }
      visitor.incomingIntentions = [];
    },

    /**
     * For pass t, select pulses that were created for pass t and map them into a per-cell override.
     * This is "field absorption" into the next snapshot.
     */
    buildOverrideMapForPass({ pulseLedger, passIndex, size }) {
      const override = new Array(size).fill(0);
      for (const p of pulseLedger) {
        if (p.passIndex !== passIndex) continue;
        // In this simplified model: any pulse hitting a cell asserts next[cell]=1
        override[p.targetIndex] = 1;
      }
      return override;
    }
  };
}

function makeObject({ objectId, ruleNumber }) {
  const f = ruleFn(ruleNumber);
  return {
    objectId,
    ruleNumber,

    /**
     * Baseline CA transition (no external pulses).
     */
    applyBaseRule(prevSnapshot) {
      const size = prevSnapshot.length;
      const next = new Array(size).fill(0);
      for (let i = 0; i < size; i++) {
        const { l, c, r } = neighborhood3(prevSnapshot, i);
        next[i] = f(l, c, r);
      }
      return next;
    },

    /**
     * Merge: if override[i]==1, force next[i]=1, else keep baseline.
     */
    mergeOverride(baselineNext, override) {
      const next = baselineNext.slice();
      for (let i = 0; i < next.length; i++) {
        if (override[i]) next[i] = 1;
      }
      return next;
    }
  };
}

function makeDesignNodes({ cpiPatterns, injectProb, reflectionHold, rng = Math.random }) {
  const patternSet = new Set((cpiPatterns || []).map(s => s.trim()).filter(Boolean));

  const DN_CPI = {
    dnId: 'DN_CPI',

    /**
     * Observes prev snapshot and emits "proposal" pulses when patterns match,
     * plus optional novelty injection pulses.
     */
    emitIntentions({ passIndex, prevSnapshot, objectId, visitor }) {
      const size = prevSnapshot.length;
      for (let i = 0; i < size; i++) {
        const { nb } = neighborhood3(prevSnapshot, i);

        let shouldPropose = false;
        let kind = null;
        let details = {};

        if (patternSet.size > 0 && patternSet.has(nb)) {
          shouldPropose = true;
          kind = 'proposal';
          details = { nb, reason: 'pattern-match' };
        }
        if (rng() < injectProb) {
          // novelty dominates; still just another pulse (immutable)
          shouldPropose = true;
          kind = 'novelty';
          details = { reason: 'random-injection' };
        }

        if (shouldPropose) {
          const pulse = makePulse({
            passIndex,
            targetIndex: i,
            pulseKind: kind,
            sourceDN: this.dnId,
            details
          });
          visitor.incomingIntentions.push(
            makeIntention({ fromDN: this.dnId, toObject: objectId, pulse })
          );
        }
      }
    }
  };

  const DN_REFLECT = {
    dnId: 'DN_REFLECT',
    consecOnes: null, // internal DN memory; not a pulse. This is DN-local state.

    init(size) {
      this.consecOnes = new Array(size).fill(0);
    },

    /**
     * Tracks persistence; after threshold emits reflection pulse to neighbor.
     */
    emitIntentions({ passIndex, prevSnapshot, objectId, visitor }) {
      const size = prevSnapshot.length;
      if (!this.consecOnes) this.init(size);

      for (let i = 0; i < size; i++) {
        const c = prevSnapshot[i];
        this.consecOnes[i] = c ? this.consecOnes[i] + 1 : 0;

        if (this.consecOnes[i] >= reflectionHold) {
          const dir = (i % 2 === 0) ? 1 : -1;
          const target = (i + dir + size) % size;

          const pulse = makePulse({
            passIndex,
            targetIndex: target,
            pulseKind: 'reflection',
            sourceDN: this.dnId,
            details: { fromIndex: i, hold: this.consecOnes[i], dir }
          });

          visitor.incomingIntentions.push(
            makeIntention({ fromDN: this.dnId, toObject: objectId, pulse })
          );
        }
      }
    }
  };

  return { DN_CPI, DN_REFLECT };
}

/** ---------- CPUX Runner ---------- */
function runCPUX_CA({ ruleNumber, size, steps, initMode }) {
  const object = makeObject({ objectId: 'O_CA', ruleNumber });
  const grid = Array.from({ length: steps }, () => new Array(size).fill(0));
  grid[0] = initRow(size, initMode);

  for (let passIndex = 1; passIndex < steps; passIndex++) {
    grid[passIndex] = object.applyBaseRule(grid[passIndex - 1]);
  }
  return grid;
}

function runCPUX_ISVariant({ ruleNumber, size, steps, initMode, cpiPatterns, injectProb, reflectionHold, rng }) {
  const visitor = makeVisitor();
  const gatekeeper = makeGatekeeper();
  const pulseLedger = []; // append-only
  const object = makeObject({ objectId: 'O_IS', ruleNumber });
  const { DN_CPI, DN_REFLECT } = makeDesignNodes({ cpiPatterns, injectProb, reflectionHold, rng });

  const grid = Array.from({ length: steps }, () => new Array(size).fill(0));
  grid[0] = initRow(size, initMode, rng);

  for (let passIndex = 1; passIndex < steps; passIndex++) {
    // visitor carries the current field snapshot
    visitor.fieldSnapshot = grid[passIndex - 1];

    // --- DN phase: DNs observe and emit intentions carrying pulses ---
    DN_CPI.emitIntentions({ passIndex, prevSnapshot: visitor.fieldSnapshot, objectId: object.objectId, visitor });
    DN_REFLECT.emitIntentions({ passIndex, prevSnapshot: visitor.fieldSnapshot, objectId: object.objectId, visitor });

    // --- Gatekeeper absorption: append new pulses to ledger (immutably) ---
    gatekeeper.absorbIntentionsIntoLedger({ visitor, pulseLedger });

    // --- Object baseline computation ---
    const baselineNext = object.applyBaseRule(visitor.fieldSnapshot);

    // --- Field absorption: build per-cell override map for this pass ---
    const override = gatekeeper.buildOverrideMapForPass({ pulseLedger, passIndex, size });

    // --- Object merges override (this creates new next snapshot; no pulse mutated) ---
    grid[passIndex] = object.mergeOverride(baselineNext, override);
  }

  return { grid, pulseLedger };
}

/** ---------- Optional: output as PGM (P2) ---------- */
function gridToPGM(grid) {
  const h = grid.length;
  const w = grid[0].length;
  const lines = [];
  lines.push('P2');         // plain PGM
  lines.push(`${w} ${h}`);  // width height
  lines.push('255');        // max pixel value
  for (let y = 0; y < h; y++) {
    // map 1->0 (black), 0->255 (white) for nicer viewing
    lines.push(grid[y].map(v => (v ? 0 : 255)).join(' '));
  }
  return lines.join('\n');
}

/** ---------- Demo (CLI) ---------- */
if (require.main === module) {
  const size = 141;
  const steps = 120;

  const ca = runCPUX_CA({ ruleNumber: 33, size, steps, initMode: 'single' });
  const is = runCPUX_ISVariant({
    ruleNumber: 33, size, steps, initMode: 'single',
    cpiPatterns: ['101', '100'],
    injectProb: 0.01,
    reflectionHold: 3
  });

  // Print small summary (not the whole grid)
  console.log('CA:    ones=', ca.flat().reduce((a,b)=>a+b,0));
  console.log('IS:    ones=', is.grid.flat().reduce((a,b)=>a+b,0), 'pulses=', is.pulseLedger.length);

  // Write PGM files (optional)
  const fs = require('fs');
  fs.writeFileSync('ca_rule33.pgm', gridToPGM(ca), 'utf-8');
  fs.writeFileSync('is_rule33_variant.pgm', gridToPGM(is.grid), 'utf-8');
  console.log('Wrote ca_rule33.pgm and is_rule33_variant.pgm');
}

module.exports = { runCPUX_CA, runCPUX_ISVariant, gridToPGM };

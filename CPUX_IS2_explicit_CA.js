'use strict';

/**
 * CPUX-style refactor of CA + IS-variant where:
 * - DNs compute and emit intentions carrying pulses
 * - Object absorbs and applies configured precedence mapping
 * - Field holds the current pass state (pulses)
 *
 * CPI = Context/Perception Injector:
 *   A DN that emits proposals based on perceived local context (e.g. LLM suggestions).
 */

/** ---------- Core types ---------- **/

class Pulse {
  constructor({ id, value, response = null, meta = {} }) {
    this.id = id;           // e.g., "cell:37"
    this.value = value;     // 0/1
    this.response = response; // immutable “meaning/response” if you use it; kept null here
    this.meta = Object.freeze({ ...meta }); // freeze meta (immutability hint)
    Object.freeze(this); // freeze pulse object (hard immutability)
  }
}

class Intention {
  constructor({ fromDN, toObject, kind, pulses, meta = {} }) {
    this.fromDN = fromDN;       // DN identity
    this.toObject = toObject;   // Object identity
    this.kind = kind;           // "baseline" | "proposal" | "reflection"
    this.pulses = pulses;       // Pulse[]
    this.meta = Object.freeze({ ...meta });
    Object.freeze(this);
  }
}

class Field {
  constructor(size) {
    this.size = size;
    this.current = new Map(); // pulseId -> Pulse (current pass state)
  }

  /** Replace entire state (next pass). */
  setNextState(nextPulseMap) {
    this.current = nextPulseMap; // Map<pulseId,Pulse>
  }

  /** Read current cell value (0/1). */
  readCell(i) {
    const p = this.current.get(`cell:${i}`);
    return p ? p.value : 0;
  }

  snapshotRow() {
    const row = new Array(this.size).fill(0);
    for (let i = 0; i < this.size; i++) row[i] = this.readCell(i);
    return row;
  }
}

/**
 * Object: absorbs intentions and applies a configured precedence mapping.
 * This is “mapping” in IS terms (policy), not DN computation.
 */
class ObjectField {
  constructor({ objectId, field, precedence }) {
    this.objectId = objectId;
    this.field = field;
    // precedence: list of intention kinds in descending priority
    // e.g. ["proposal", "reflection", "baseline"]
    this.precedence = precedence;
  }

  /**
   * Absorb a batch of intentions for this pass and produce the next-pass field.
   * Mapping policy:
   *   For each cell pulseId, pick the highest-precedence pulse present.
   * No DN logic here: only policy-based selection.
   */
  absorbIntentionsAndAdvance(intentions) {
    // bucket pulses by kind
    const byKind = new Map(); // kind -> Map<pulseId,Pulse>
    for (const kind of this.precedence) byKind.set(kind, new Map());

    for (const it of intentions) {
      if (it.toObject !== this.objectId) continue;
      if (!byKind.has(it.kind)) continue;
      const m = byKind.get(it.kind);
      for (const p of it.pulses) m.set(p.id, p);
    }

    // produce nextPulseMap by precedence
    const nextPulseMap = new Map();
    for (let i = 0; i < this.field.size; i++) {
      const pid = `cell:${i}`;
      let chosen = null;
      for (const kind of this.precedence) {
        const m = byKind.get(kind);
        if (m && m.has(pid)) { chosen = m.get(pid); break; }
      }
      // default if nothing emitted (should not happen if baseline covers all)
      if (!chosen) chosen = new Pulse({ id: pid, value: 0 });
      nextPulseMap.set(pid, chosen);
    }

    this.field.setNextState(nextPulseMap);
  }
}

/** ---------- Gatekeeper / Visitor (CPUX loop scaffold) ---------- **/

class Gatekeeper {
  constructor({ routeTable }) {
    this.routeTable = routeTable; // DN name -> objectId
  }
  routeIntention(intention) {
    // Here “routing” is trivial: DN already targets object; keep hook for real routing.
    return intention;
  }
}

class Visitor {
  constructor({ dNodesInOrder, gatekeeper, objectField }) {
    this.dNodesInOrder = dNodesInOrder; // DN[]
    this.gatekeeper = gatekeeper;
    this.objectField = objectField;
  }

  /**
   * One CPUX pass:
   * - Visit each DN in order; collect their emitted intentions
   * - Gatekeeper routes them
   * - Object absorbs and advances Field to next pass
   */
  pass({ passIndex }) {
    const emitted = [];
    for (const dn of this.dNodesInOrder) {
      const its = dn.emitIntentions({ passIndex });
      for (const it of its) emitted.push(this.gatekeeper.routeIntention(it));
    }
    this.objectField.absorbIntentionsAndAdvance(emitted);
  }
}

/** ---------- DNs (closed components) ---------- **/

function ruleFn(ruleNumber) {
  return (l, c, r) => {
    const idx = (l << 2) | (c << 1) | r;
    return (ruleNumber >> idx) & 1;
  };
}

class DN_rule {
  constructor({ dnId, objectId, field, ruleNumber }) {
    this.dnId = dnId;
    this.objectId = objectId;
    this.field = field;
    this.f = ruleFn(ruleNumber);
  }

  emitIntentions({ passIndex }) {
    // baseline CA computation: next row derived from current field
    const pulses = [];
    const size = this.field.size;

    for (let i = 0; i < size; i++) {
      const l = this.field.readCell((i - 1 + size) % size);
      const c = this.field.readCell(i);
      const r = this.field.readCell((i + 1) % size);
      const v = this.f(l, c, r);
      pulses.push(new Pulse({ id: `cell:${i}`, value: v, meta: { src: 'DN_rule', passIndex } }));
    }

    return [
      new Intention({
        fromDN: this.dnId,
        toObject: this.objectId,
        kind: 'baseline',
        pulses,
        meta: { passIndex }
      })
    ];
  }
}

class DN_cpi {
  constructor({ dnId, objectId, field, cpiPatterns }) {
    this.dnId = dnId;
    this.objectId = objectId;
    this.field = field;
    this.cpiPatterns = new Set(cpiPatterns); // e.g. ["101","100"]
  }

  emitIntentions({ passIndex }) {
    const pulses = [];
    const size = this.field.size;

    for (let i = 0; i < size; i++) {
      const l = this.field.readCell((i - 1 + size) % size);
      const c = this.field.readCell(i);
      const r = this.field.readCell((i + 1) % size);
      const nb = `${l}${c}${r}`;
      if (this.cpiPatterns.has(nb)) {
        // CPI proposes setting this cell to 1 (perception-driven override)
        pulses.push(new Pulse({ id: `cell:${i}`, value: 1, meta: { src: 'DN_cpi', nb, passIndex } }));
      }
    }

    if (pulses.length === 0) return [];
    return [
      new Intention({
        fromDN: this.dnId,
        toObject: this.objectId,
        kind: 'proposal',
        pulses,
        meta: { passIndex, note: 'CPI proposals' }
      })
    ];
  }
}

class DN_inject {
  constructor({ dnId, objectId, field, injectProb, rng = Math.random }) {
    this.dnId = dnId;
    this.objectId = objectId;
    this.field = field;
    this.injectProb = injectProb;
    this.rng = rng;
  }

  emitIntentions({ passIndex }) {
    if (this.injectProb <= 0) return [];
    const pulses = [];
    const size = this.field.size;

    for (let i = 0; i < size; i++) {
      if (this.rng() < this.injectProb) {
        pulses.push(new Pulse({ id: `cell:${i}`, value: 1, meta: { src: 'DN_inject', passIndex } }));
      }
    }

    if (pulses.length === 0) return [];
    return [
      new Intention({
        fromDN: this.dnId,
        toObject: this.objectId,
        kind: 'proposal',
        pulses,
        meta: { passIndex, note: 'novelty injection' }
      })
    ];
  }
}

class DN_reflect {
  constructor({ dnId, objectId, field, reflectionHold }) {
    this.dnId = dnId;
    this.objectId = objectId;
    this.field = field;
    this.reflectionHold = reflectionHold;
    this.consecOnes = new Array(field.size).fill(0); // DN-owned history (not Object-owned)
  }

  emitIntentions({ passIndex }) {
    if (this.reflectionHold >= 1e9) return [];
    const pulses = [];
    const size = this.field.size;

    for (let i = 0; i < size; i++) {
      const c = this.field.readCell(i);
      this.consecOnes[i] = c ? this.consecOnes[i] + 1 : 0;

      if (this.consecOnes[i] >= this.reflectionHold) {
        const dir = (i % 2 === 0) ? 1 : -1;
        const target = (i + dir + size) % size;
        pulses.push(new Pulse({ id: `cell:${target}`, value: 1, meta: { src: 'DN_reflect', from: i, passIndex } }));
      }
    }

    if (pulses.length === 0) return [];
    return [
      new Intention({
        fromDN: this.dnId,
        toObject: this.objectId,
        kind: 'reflection',
        pulses,
        meta: { passIndex }
      })
    ];
  }
}

/** ---------- Runner helpers ---------- **/

function initRow(size, initMode) {
  const map = new Map();
  if (initMode === 'single') {
    const mid = Math.floor(size / 2);
    for (let i = 0; i < size; i++) {
      map.set(`cell:${i}`, new Pulse({ id: `cell:${i}`, value: i === mid ? 1 : 0, meta: { src: 'init' } }));
    }
  } else if (initMode === 'random') {
    for (let i = 0; i < size; i++) {
      map.set(`cell:${i}`, new Pulse({ id: `cell:${i}`, value: Math.random() < 0.1 ? 1 : 0, meta: { src: 'init' } }));
    }
  } else {
    for (let i = 0; i < size; i++) map.set(`cell:${i}`, new Pulse({ id: `cell:${i}`, value: 0, meta: { src: 'init' } }));
  }
  return map;
}

function runCPUX({ size, steps, initMode, dNodesInOrder, precedence }) {
  const field = new Field(size);
  field.setNextState(initRow(size, initMode));

  const objectId = 'O_field';
  const objectField = new ObjectField({ objectId, field, precedence });
  const gatekeeper = new Gatekeeper({ routeTable: {} });
  const visitor = new Visitor({ dNodesInOrder, gatekeeper, objectField });

  const grid = [];
  grid.push(field.snapshotRow());

  for (let t = 1; t < steps; t++) {
    visitor.pass({ passIndex: t });
    grid.push(field.snapshotRow());
  }
  return grid;
}

/** ---------- Demos ---------- **/

function demo_rule33_pair() {
  const size = 141, steps = 120, rule = 33;

  // CA: only DN_rule; precedence irrelevant but keep baseline last
  {
    const field = new Field(size);
    // wire DNs with the field instance used by runner
  }

  // For runner we must instantiate DNs *after* we create a field inside runCPUX.
  // So we use factories that accept the field.
  const CA = (() => {
    const field = new Field(size);
    field.setNextState(initRow(size, 'single'));
    const dnRule = new DN_rule({ dnId: 'DN_rule33', objectId: 'O_field', field, ruleNumber: rule });

    const objectField = new ObjectField({ objectId: 'O_field', field, precedence: ['baseline'] });
    const visitor = new Visitor({
      dNodesInOrder: [dnRule],
      gatekeeper: new Gatekeeper({ routeTable: {} }),
      objectField
    });

    const grid = [field.snapshotRow()];
    for (let t = 1; t < steps; t++) { visitor.pass({ passIndex: t }); grid.push(field.snapshotRow()); }
    return grid;
  })();

  const IS = (() => {
    const field = new Field(size);
    field.setNextState(initRow(size, 'single'));

    const dnRule = new DN_rule({ dnId: 'DN_rule33', objectId: 'O_field', field, ruleNumber: rule });
    const dnCPI = new DN_cpi({ dnId: 'DN_cpi', objectId: 'O_field', field, cpiPatterns: ['101', '100'] });
    const dnInject = new DN_inject({ dnId: 'DN_inject', objectId: 'O_field', field, injectProb: 0.01 });
    const dnReflect = new DN_reflect({ dnId: 'DN_reflect', objectId: 'O_field', field, reflectionHold: 3 });

    const objectField = new ObjectField({
      objectId: 'O_field',
      field,
      // precedence policy = mapping configuration
      precedence: ['proposal', 'reflection', 'baseline']
    });

    const visitor = new Visitor({
      dNodesInOrder: [dnCPI, dnInject, dnReflect, dnRule],
      gatekeeper: new Gatekeeper({ routeTable: {} }),
      objectField
    });

    const grid = [field.snapshotRow()];
    for (let t = 1; t < steps; t++) { visitor.pass({ passIndex: t }); grid.push(field.snapshotRow()); }
    return grid;
  })();

  return { CA, IS };
}

/** ---------- Minimal CLI output as PGM (so you can render as image) ---------- **/

function writePGM(grid) {
  const height = grid.length;
  const width = grid[0].length;
  let out = '';
  out += 'P2\n';
  out += `${width} ${height}\n`;
  out += '255\n';
  for (let y = 0; y < height; y++) {
    const row = grid[y].map(v => (v ? 0 : 255)); // black for 1, white for 0
    out += row.join(' ') + '\n';
  }
  return out;
}

/** ---------- Run if called directly ---------- **/

if (require.main === module) {
  const { CA, IS } = demo_rule33_pair();

  // Write PGM files
  const fs = require('fs');
  fs.writeFileSync('ca_rule33.pgm', writePGM(CA), 'utf-8');
  fs.writeFileSync('is_rule33_variant.pgm', writePGM(IS), 'utf-8');

  console.log('Wrote ca_rule33.pgm and is_rule33_variant.pgm');
  console.log('Tip: convert to PNG with ImageMagick:');
  console.log('  magick ca_rule33.pgm ca_rule33.png');
  console.log('  magick is_rule33_variant.pgm is_rule33_variant.png');
}

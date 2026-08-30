// test-wheel.mjs — the Y class-tree wheel.
//
// The wheel's layout is derived from TANK_DEFS' upgrade graph, so a regenerated
// dump can silently reshape it. Load the browser scripts into a vm with a
// recording 2D context, draw the overlay, and assert the geometry.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert';

const arcs = [];
const ctx = new Proxy({}, {
  get(_, k) {
    if (k === 'measureText') return () => ({ width: 10 });
    if (k === 'arc') return (x, y, r, a0, a1, ccw) => arcs.push({ x, y, r, a0, a1, ccw });
    return () => {};
  },
  set() { return true; }
});
const canvas = { width: 1280, height: 720, getContext: () => ctx };

const sandbox = {
  console, performance, Math, JSON, Date,
  document: { getElementById: () => canvas },
  window: { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720 }
};
vm.createContext(sandbox);
for (const f of ['data.js', 'tankdefs.js', 'tankdefs-extra.js', 'protocol.js', 'render.js'])
  vm.runInContext(fs.readFileSync(new URL('./js/' + f, import.meta.url), 'utf8'), sandbox, { filename: f });

const r = new sandbox.Renderer(canvas, { player: { def: sandbox.TANK_DEFS[0], level: 1 }, tick: 0 });

r.treeT0 = performance.now();
r.drawClassTree();
assert.ok(arcs.length, 'the opening frame drew nothing');

r.treeT0 = performance.now() - 5000;
arcs.length = 0;
r.drawClassTree();
assert.ok(arcs.every(a => Number.isFinite(a.r + a.a0 + a.a1)), 'NaN in wheel geometry');

// tank icons draw their own arcs, but only wheel geometry is centred on the canvas
const CX = canvas.width / 2, CY = canvas.height / 2;
const wheel = (a) => a.x === CX && a.y === CY;
const ring = arcs.filter(wheel);
const sectors = (ring.length - 2) / 2;   // 2 arcs per sector, + 2 hub circles

let nodes = 0, leaves = 0;
(function count(n) { n.kids.forEach(k => { nodes++; if (!k.kids.length) leaves++; count(k); }); })(r.tree);
assert.strictEqual(sectors, nodes, `drew ${sectors} sectors for ${nodes} tree nodes`);

// every sector spans exactly one ring band, and the bands add up
const R = Math.min(canvas.width, canvas.height) / 2 * 0.86;
const bands = sandbox.TREE_RADII.map(f => +(R * f).toFixed(3));
const span = new Map();
for (let i = 0; i < sectors; i++) {
  const a = ring[i * 2], b = ring[i * 2 + 1];
  const lo = bands.indexOf(+a.r.toFixed(3));
  assert.ok(lo >= 0 && +b.r.toFixed(3) === bands[lo + 1], `sector ${i} spans a non-ring radius`);
  span.set(lo, (span.get(lo) || 0) + (a.a1 - a.a0));
}
const TAU = Math.PI * 2;
// every leaf is a level-45 class, so the outer ring tiles the full circle...
assert.ok(Math.abs(span.get(2) - TAU) < 1e-9, 'outer ring does not tile the circle');
// ...while the inner two fall short exactly where a class skips a tier: Smasher
// (L30 off Tank) holes ring 1, Sprayer (L45 off Machine Gun) holes ring 2.
assert.ok(span.get(0) < TAU - 0.1, 'ring 1 has no gap for Smasher');
assert.ok(span.get(1) < TAU - 0.1, 'ring 2 has no gap for Sprayer');

// the intro grows outward and turns clockwise; the idle spin keeps turning clockwise
const at = (ms) => { r.treeT0 = performance.now() - ms; arcs.length = 0; r.drawClassTree(); return arcs.filter(wheel)[0]; };
const early = at(60), late = at(300);
assert.ok(late.r > early.r, 'the wheel does not grow outward');
assert.ok(late.a0 > early.a0, 'the intro rotation is not clockwise');
const spinA = at(5000).a0;
for (const t = performance.now(); performance.now() - t < 60;);
assert.ok(at(5060).a0 > spinA, 'the idle spin is not clockwise');

// --- the second tree ----------------------------------------------------
// A mode may root the wheel on a tree of its own. Juggernaut Royale's is six
// rings deep and a hundred and forty hulls wide, which is the case the three-ring layout
// could not draw at all: it needs a generated band table and its own radius,
// and the Basic tree above must keep the ones it had. It also asks for
// treeUnique, so a hull with three parents is drawn once rather than three
// times — without it the same graph expands to well over a thousand slivers.
for (const f of ['engine.js', 'modes.js', 'modes-extra.js'])
  vm.runInContext(fs.readFileSync(new URL('./js/' + f, import.meta.url), 'utf8'), sandbox, { filename: f });

const B = sandbox.JR_BASE;
const JMODE = sandbox.GAMEMODES.juggerroyale;
assert.ok(JMODE.treeUnique, 'the juggernaut mode no longer asks for a deduped wheel');
const jr = new sandbox.Renderer(canvas, {
  player: { def: sandbox.TANK_DEFS[B], level: 1 },
  mode: JMODE, tick: 0
});
jr.treeT0 = performance.now() - 5000;
arcs.length = 0;
jr.drawClassTree();
const RINGS = 8;
assert.strictEqual(jr.treeRings, RINGS, `juggernaut wheel came out ${jr.treeRings} rings deep`);
assert.deepStrictEqual(jr.treeRadii, sandbox.treeBands(RINGS), 'the deep wheel did not take its band table');
assert.strictEqual(jr.treeRadii.length, RINGS + 1, 'an eight-ring wheel needs nine radius stops');
assert.ok(arcs.every(a => Number.isFinite(a.r + a.a0 + a.a1)), 'NaN in juggernaut wheel geometry');

const jring = arcs.filter(wheel);
const jsectors = (jring.length - 2) / 2;
let jnodes = 0, jleaves = 0;
(function count(n) { n.kids.forEach(k => { jnodes++; if (!k.kids.length) jleaves++; count(k); }); })(jr.tree);
assert.strictEqual(jsectors, jnodes, `drew ${jsectors} sectors for ${jnodes} juggernaut nodes`);
// every hull but the Brute at the hub, exactly once
assert.strictEqual(jnodes, sandbox.JR_HULLS.length - 1,
  `${jnodes} sectors for ${sandbox.JR_HULLS.length - 1} hulls — the wheel is not one sector per hull`);

// eight bands, and every sector sits in exactly one of them
const JR = Math.min(canvas.width, canvas.height) / 2 * 0.985;
const jbands = sandbox.treeBands(RINGS).map(f => +(JR * f).toFixed(3));
const jspan = new Map();
for (let i = 0; i < jsectors; i++) {
  const a = jring[i * 2], b = jring[i * 2 + 1];
  const lo = jbands.indexOf(+a.r.toFixed(3));
  assert.ok(lo >= 0 && +b.r.toFixed(3) === jbands[lo + 1], `juggernaut sector ${i} spans a non-ring radius`);
  jspan.set(lo, (jspan.get(lo) || 0) + (a.a1 - a.a0));
}
assert.strictEqual(jspan.size, RINGS, `juggernaut wheel used ${jspan.size} rings, not ${RINGS}`);
assert.ok(Math.abs(jspan.get(0) - TAU) < 1e-9, 'the eleven branches do not tile the circle');
// ...and it really is a bigger wheel than the Basic one
assert.ok(JR > R, 'the deep wheel is not drawn any bigger than the three-ring one');

console.log(`wheel ok — ${sectors} sectors, ${leaves} tier-4 leaves, both animations clockwise`);
console.log(`juggernaut wheel ok — ${jsectors} sectors over ${RINGS} rings, ${jleaves} endings, radius ${(JR / R).toFixed(2)}x`);

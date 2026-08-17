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
for (const f of ['data.js', 'tankdefs.js', 'tankdefs-extra.js', 'render.js'])
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

console.log(`wheel ok — ${sectors} sectors, ${leaves} tier-4 leaves, both animations clockwise`);

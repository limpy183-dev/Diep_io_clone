# Diep.io Projectile Physics — Reference

Exact per-tick movement rules for every projectile type in the real diep.io.

## Sources & confidence

| Source | What it is | Weight |
|---|---|---|
| [ABCxFF/diepindepth `physics/README.txt`](https://github.com/ABCxFF/diepindepth/blob/main/physics/README.txt) | Formulas derived from the real game's WASM/memory by reverse engineering | **Primary** |
| [ABCxFF/diepindepth `memory/structs/BarrelDefinition.h`](https://github.com/ABCxFF/diepindepth/blob/main/memory/structs/BarrelDefinition.h) | The actual 100-byte barrel struct layout ripped from game memory | **Primary** |
| [ABCxFF/diepcustom](https://github.com/ABCxFF/diepcustom) `src/Entity/Object.ts`, `src/Entity/Tank/Barrel.ts`, `src/Entity/Tank/Projectile/*.ts`, `src/config.ts` | A working server that speaks diep.io's real protocol; the physics is the reference implementation of the above | **Primary** |

The two agree exactly wherever they overlap (see §2.2), which is the main reason to trust them. Everything below marked ⚠ is where the sources are silent or flag themselves as unverified.

Units are **du** (diep units, the server's world coordinates) and **t** (ticks).

---

## 1. The integrator — this is 90% of the answer

The server runs at **`mspt = 40` → 25 ticks/second**. Everything is integer-tick; there is no delta-time. The client interpolates between snapshots but simulates nothing authoritative.

Every entity in the game — tanks, shapes, bullets, drones, traps — runs the exact same integrator, once per tick, in this order:

```js
// per entity, per tick — src/Entity/Object.ts applyPhysics()
if (velocity.magnitude < 0.01) velocity.magnitude = 0;   // dead-stop snap
else if (isDying) velocity.magnitude /= 2;               // death animation

position.x += velocity.x;                                // 1. move
position.y += velocity.y;

velocity += polar(velocity.angle, velocity.magnitude * -0.1);   // 2. friction: v *= 0.9
```

then, immediately after, the entity's own `tick()` applies its acceleration:

```js
// maintainVelocity(angle, maxSpeed) — src/Entity/Object.ts
velocity += polar(angle, maxSpeed * 0.1);                // 3. accelerate
```

Three consequences that fall straight out of this:

1. **Friction is a flat 10% per tick.** `v(n) = v0 · 0.9ⁿ`. Nothing in diep.io has drag proportional to size, mass, or speed² — the "bigger bullets slow down faster" folklore is wrong; a Destroyer bullet decelerates at exactly the same *rate* as a Twin bullet, it just starts and settles lower.
2. **Max speed = 10 × acceleration.** Fixed point of `v ← 0.9v + 0.1A` is `v = A`. This is why the code stores "acceleration" as a max-speed number and multiplies by `0.1` at use — `A` in every formula below *is* the terminal speed.
3. **Approach to terminal speed is `A(1 − 0.9ⁿ)` from rest, or `A + (v0 − A)·0.9ⁿ` in general.** Half of the transient is gone in ~6.6 ticks (0.26 s), 99% in ~44 ticks (1.75 s).

There is **no gravity, no air resistance model, no mass, no angular momentum, no restitution.** Collisions are impulses on velocity, nothing else. All collision shapes are circles except maze walls / bases / arena, which are AABBs (rect-vs-rect collision is not implemented in the real game either).

---

## 2. Bullet launch

### 2.1 Base acceleration (= terminal speed)

```
A = (20 + 3 · bulletSpeedStat) · speed        [du/t]
```

- `bulletSpeedStat` ∈ [0, 7] — the Bullet Speed upgrade points.
- `speed` — per-barrel constant from the tank definition (`bullet_speed` @0x24 in `BarrelDefinition`). 1.0 for Basic, 1.5 for Sniper, 0.7 for Destroyer, etc.

diepindepth writes the same thing as an acceleration, `b_A = (2 + 0.3·b_s) · B_S`, with max speed `10·b_A` — identical.

### 2.2 Initial (launch) speed

```
v0 = A + 30 − U(0, scatterRate)               [du/t]
```

Where `U(0, scatterRate)` is a fresh uniform random draw per shot. So **every bullet is launched at 30 du/t above its own terminal speed** and decays down to it — the muzzle "kick" is a fixed +30 du/t (+750 du/s) for every bullet in the game regardless of tank, and it is fully spent within ~2 seconds.

`scatterRate` (`spread_multiplier` @0x44) does double duty: it subtracts up to that much from launch speed *and* controls angular spread (§2.3). Machine Gun's `scatterRate = 3` is why its bullets visibly fan out and arrive at slightly different times; Sniper's `0.3` is why it doesn't.

### 2.3 Launch angle

```js
scatterAngle = (π/180) · scatterRate · (random() − 0.5) · 10
angle        = barrelDefinition.angle + scatterAngle + tank.angle
```

i.e. **uniform in ±(5 · scatterRate) degrees**. Machine Gun = ±15°, Basic = ±5°, Sniper = ±1.5°.

### 2.4 Spawn position

```js
x = tankWorldX + cos(angle)·barrelLength − sin(angle)·offset·sizeFactor + cos(angle)·distance
y = tankWorldY + sin(angle)·barrelLength + cos(angle)·offset·sizeFactor + sin(angle)·distance
```

`barrelLength = barrel.size · sizeFactor`, `sizeFactor = 1.01^(level−1)`. The bullet is placed at the muzzle, **not** at the tank centre.

### 2.5 Bullet size

```
radius = (barrel.width · sizeFactor / 2) · sizeRatio        [du]
```

Basic (`width 42`, `sizeRatio 1`, level 1) → radius 21 du. This is the *only* thing barrel width does mechanically.

### 2.6 Launch does not inherit the shooter's velocity

The bullet is constructed with `velocity = 0`. Moving forward while shooting does **not** make your bullets faster in diep.io. Only the shooter's *position* at fire time matters.

### 2.7 The one-tick launch delay (implementation detail, but it's real)

```js
// Bullet.tick()
if (tick === spawnTick + 1) addVelocity(movementAngle, baseSpeed);   // the launch impulse
else                        maintainVelocity(movementAngle, baseAccel);
```

On its **spawn** tick the bullet only receives `0.1·A`; the actual `v0` impulse lands one tick later. So the true velocity sequence is:

| tick | velocity after that tick |
|---|---|
| spawn | `0.1·A` |
| spawn+1 | `0.09·A + v0` |
| spawn+2… | `0.9·v_prev + 0.1·A` |

A Basic bullet at 0 bullet-speed: `2 → 51.3 → 48.17 → 45.35 → 42.82 → …` converging on 20 du/t.

### 2.8 Recoil on the shooter

```
tank.velocity += polar(angle + π, 2 · barrel.recoil)      [du/t, one-shot impulse]
```

Applied to the tank, not the bullet. Annihilator's `recoil 17` → a 34 du/t impulse backwards, which is where Anni-boosting comes from.

---

## 3. Lifetime, range, and death

```
lifeTicks = 75 · lifeLength          (bullets)
```

with `lifeLength` from the barrel def (`bullet_durability` @0x48). Default 1 → **75 ticks = 3.0 seconds**. Killed by `tick − spawnTick >= lifeTicks`, so fractional values round up.

**Closed-form range** for a bullet fired at `v0` with terminal speed `A` over `N` ticks (verified against a tick-exact simulation, §7):

```
range = 0.1·A  +  A·(N−1)  +  (v0 + 0.09·A − A) · (1 − 0.9^(N−1)) / 0.1        [du]
      ≈ A·N + 10·(30 − scatter)          for N ≳ 45
```

The `10 × 30 = 300 du` term is the fixed contribution of that universal +30 du/t muzzle kick.

**Death animation.** `destroy(true)` does not remove the projectile instantly. For the next 5 ticks (0.2 s) it: halves its velocity every tick, scales up by 1.1× every tick (≈1.61× final), and loses 1/6 opacity per tick. It is deleted on the 6th. It stops colliding the moment the animation starts.

---

## 4. Per-type deviations

Everything below inherits §1–§3 and only changes the listed fields.

### Bullet (Basic, Twin, Sniper, Gunner, Destroyer, Streamliner, …)
Baseline. `canEscapeArena` set — bullets fly past the arena border, drones do not.

### Trap (Trapper, Mega Trapper, Gunner Trapper)
```
v0    = A/2 + 30 − U(0, scatterRate)
accel = 0                              ← no thrust at all
lifeTicks   = (600 · lifeLength) >> 3          // = 600 t = 24 s at lifeLength 8
collisionEnd = (75 · lifeLength) >> 3          // = 75 t = 3 s
spawn angle = random ∈ [0, 2π)                 // visual spin only
```
Traps are bullets with the engine switched off. They coast `v0 · 10 ≈ 705 du` (geometric sum of `0.9ⁿ`) and then hard-stop at the `< 0.01` snap. For the first `collisionEnd` ticks a trap only collides with projectiles from the **same owner**; after that it flips to normal team collision — that's the grace window that lets you shoot through your own fresh traps.

### Drone (Overseer, Overlord, Manager, Battleship swarm)
```
v0        = (A + 30 − U(0, scatterRate)) / 3   ← launched at a third speed
accel     = A, applied along positionData.angle (not a fixed launch angle)
lifeTicks = 88 · lifeLength, or ∞ if lifeLength === -1
```
The steering angle is set every tick by the controller, then the same `maintainVelocity(angle, A)` runs — so a drone turning 180° does not stop and reverse instantly, it decays through zero at the 10%/tick rate. That lag *is* the drone-turning feel.

- **Player-controlled:** `angle = atan2(mouse − dronePos)`; right-click (repel) adds π.
- **Idle / auto:** targets the nearest valid enemy within a 900 du view radius, with lead prediction (§5). With no target it orbits the owner: outside a 400 du radius it aims at a point tangent to the owner (`atan2(delta) + π/2`, offset by `1.2 × ownerRadius`); inside, it divides `A` by 6 and precesses `0.01 + 0.012·unitDist` rad/tick. `A` is divided by 3 when within half the resting radius.
- Drones do **not** have `canEscapeArena` — they get clamped at the border.
- `pushFactor` is hard-set to **4** for drones, overriding the bullet formula.

### Necromancer square
Drone, but `v0 = 0` — spawns dead-still and accelerates from rest. `maxDamageMultiplier = 4`.

### Minion (Factory)
Drone + its own barrel. Uses `movementAngle` rather than `positionData.angle`, and picks the angle by range band around the target: closer than `FOCUS_RADIUS/7` (≈302 du) → flee (`angle + π`); closer than `FOCUS_RADIUS` (800 du) → strafe (`angle + π/2`); else → approach. Body size ×1.2.

### Swarm (Battleship)
Drone with `viewRange = 2000` and `canEscapeArena | noOwnTeamCollision` set. Finite `lifeLength`, so 88 ticks.

### Flame (Skimmer/Fallen variants)
```
v0        = 2 · (A + 30 − U(0, scatterRate))   ← double launch speed
accel     = 0
lifeTicks = 25 · lifeLength
pushFactor = absorbtionFactor = 0              ← passes through everything, no knockback
damageReduction: 1 → 2 over 25 ticks; opacity −1/25 per tick
```
Deleted with `destroy(false)` — no death animation.

### Skimmer shell
A bullet that additionally spins `positionData.angle += ±0.1 rad/tick` (sign flips on right-click) and carries two opposed barrels (`reload 0.35`, `recoil 0` — no thrust) that fire continuously. Its own motion is plain bullet motion.

### Rocket (Rocketeer)
A bullet carrying one rear-facing barrel (`angle = π`, `reload 0.15`, **`recoil 3.3`**). Each of its own shots applies a `2 × 3.3 = 6.6 du/t` forward impulse to the rocket. That thrust, not `speed = 0.3` (A = 6–12.3 du/t), is what makes a rocket fast — it accelerates over its whole flight instead of settling at a terminal speed. Thrust starts after `tick − spawnTick >= tank.reloadTime`.

### Croc skimmer (Fallen Booster drop)
Bullet with two `angle = ±π/2` barrels, `speed 0.2`, `reload 0.5`. No self-thrust.

---

## 5. Auto-turret / drone lead prediction

`AI.aimAtTarget()` with `doAimPrediction` (auto turrets, auto tanks). `movementSpeed = 1.6 × bulletTerminalSpeed`:

```js
perp   = (delta.y, −delta.x) / |delta|                       // unit perpendicular
vPerp  = clamp(dot(perp, target.velocity), ±0.9·movementSpeed)
vDirect = sqrt(movementSpeed² − vPerp²)
offset  = (vPerp / vDirect · |delta|) / 2                    // note the /2
aimPoint = targetPos + offset · perp
```

The `/2` means diep's auto-aim deliberately **under-leads by half** — it is not a correct intercept solve, and that's why auto turrets consistently trail fast crossing targets.

---

## 6. Collision response (what changes a projectile's velocity besides thrust)

### Knockback
```
impulse = self.absorbtionFactor × other.pushFactor          [du/t, added to velocity]
angle   = atan2(selfPos − otherPos)   (random if exactly coincident)
```
For a bullet:
```
absorbtionFactor = barrel def constant (1.0 normally; 0.1 Destroyer/Skimmer/Rocketeer, 0.05 Annihilator)
pushFactor       = (7/3 + bulletDamageStat) · damage · absorbtionFactor
```
The low `absorbtionFactor` on Destroyer/Annihilator is exactly why their bullets barely flinch when they hit something. Reference `pushFactor` / `absorbtionFactor` values: default 8.0 / 1.0, drones 4.0, small crasher 12.0 / 2.0, pentagon 11.0 / 0.5, alpha pentagon 11.0 / 0.05, maze wall 2.0 / 0.0.

### Walls and bases
- Hitting a **solid wall** as an enemy-team projectile with an owner → `velocity = 0` and `destroy(true)`. Bullets die on maze walls.
- Otherwise `velocity *= 0.3`, and the knockback magnitude is divided by 0.3 (i.e. ×3.33).
- Against a **rectangle** the knockback is snapped to the nearest of the 4 axis directions (compare `cos(kbAngle + rectAngle)/size` vs `sin(kbAngle + rectAngle)/width`), not the true contact normal.
- Entities with `canMoveThroughWalls` take zero rect knockback.

### Damage (for completeness — it feeds back into movement via death)
```
bullet damagePerTick = (7 + 3·bulletDamageStat) · damage
bullet maxHealth     = (1.5·bulletPenetrationStat + 2) · health
```
Bullet-vs-bullet uses `minDamageMultiplier = 0.25` (the "75% bullet damage reduction"), `maxDamageMultiplier = 1`. Drones and necro squares use `min = 1`. Mutual-kill damage is scaled by the health/DPT ratio so neither over-kills.

> ⚠ diepindepth's §5.2.2 writes this as `(7 + B_D·3) · b_DS`, swapping the stat and the definition constant. The implementation — and the arithmetic that makes Basic's 8 dmg/tick come out right — is `(7 + 3·stat) · definition.damage`.

---

## 7. Verified numbers

Generated by tick-exact simulation of §1's loop; the closed-form range in §3 matches it to the unit on every row. Scatter is taken at its expectation (`scatterRate/2`); a real shot varies by ±`scatterRate/2` du/t of launch speed.

| projectile | `speed` | terminal du/t (0 / 7 spd) | launch du/t (0 / 7) | life | range du (0 / 7) |
|---|---|---|---|---|---|
| Tank / Twin / Octo | 1 | 20 / 41 | 49.5 / 70.5 | 75 t (3.0 s) | 1795 / 3370 |
| Machine Gun | 1 | 20 / 41 | 48.5 / 69.5 | 75 t (3.0 s) | 1785 / 3360 |
| Sniper / Ranger / Assassin | 1.5 | 30 / 61.5 | 59.85 / 91.35 | 75 t (3.0 s) | 2548 / 4911 |
| Hunter / Predator | 1.4 | 28 / 57.4 | 57.85 / 87.25 | 75 t (3.0 s) | 2398 / 4603 |
| Gunner / Auto Gunner | 1.1 | 22 / 45.1 | 51.5 / 74.6 | 75 t (3.0 s) | 1945 / 3677 |
| Streamliner | 1.1 | 22 / 45.1 | 51.85 / 74.95 | 60 t (2.4 s) | 1618 / 3004 |
| Destroyer / Annihilator | 0.7 | 14 / 28.7 | 43.5 / 58.2 | 75 t (3.0 s) | 1345 / 2447 |
| Booster/Fighter thrusters | 1 | 20 / 41 | 49.5 / 70.5 | 38 t (1.5 s) | 1028 / 1805 |
| Skimmer shell | 0.5 | 10 / 20.5 | 39.5 / 50 | 98 t (3.9 s) | 1265 / 2283 |
| Rocketeer rocket (no thrust) | 0.3 | 6 / 12.3 | 35.5 / 41.8 | 75 t (3.0 s) | 745 / 1217 † |
| Trapper / Mega Trapper | 2 | (no thrust) | 49.5 / 70.5 | 600 t (24 s) | 495 / 705 |
| Overseer / Overlord drone | 0.8 | 16 / 32.8 | 15.17 / 20.77 | ∞ | — |
| Necromancer square | 0.72 | 14.4 / 29.52 | 0 / 0 | ∞ | — |
| Battleship swarm | 1 | 20 / 41 | 16.5 / 23.5 | 88 t (3.5 s) | 1725 / 3433 |
| Factory minion | 0.56 | 11.2 / 22.96 | 13.57 / 17.49 | ∞ | — |

† Rocket range is much larger in practice — see §4, its own barrel adds 6.6 du/t per shot for the whole flight.

Multiply du/t by 25 for du/s. A level-1 tank body radius is `25√2 ≈ 35.36` du, a square is `55√2/2 ≈ 38.89` du — so a Basic bullet's 1795 du range is ~50 tank-widths.

### The check

```js
// verifies §1's loop, §2's formulas and §3's closed form agree. `node check.mjs`
const sim = ({B_S=1, b_s=0, scatterRate=1, lifeLength=1}) => {
  const A = (20 + 3*b_s) * B_S, v0 = A + 30 - scatterRate/2, N = 75*lifeLength;
  let v = 0, d = 0;
  for (let t = 0; t <= N; t++) {
    if (Math.abs(v) < 0.01) v = 0;
    d += v; v -= v * 0.1;                     // move, then friction
    v += (t === 1) ? v0 : A * 0.1;            // launch impulse, else maintainVelocity
  }
  return { terminal: v, range: d };
};
const closed = ({B_S=1, b_s=0, scatterRate=1, lifeLength=1}) => {
  const A = (20 + 3*b_s) * B_S, v0 = A + 30 - scatterRate/2, n = 75*lifeLength - 1;
  return 0.1*A + A*n + (v0 + 0.09*A - A) * (1 - 0.9**n) / 0.1;
};
for (const c of [{}, {b_s:7}, {B_S:1.5, b_s:7, scatterRate:0.3}, {B_S:0.7, lifeLength:0.8}]) {
  const s = sim(c);
  // terminal speed is asymptotic: |v − A| = (v0 − A)·0.9^n, still ~0.06 after a 60-tick flight
  console.assert(Math.abs(s.terminal - (20 + 3*(c.b_s||0)) * (c.B_S ?? 1)) < 0.1, 'terminal != A', c);
  console.assert(Math.abs(s.range - closed(c)) < 0.5, 'closed form != sim', c);
}
// and it really does converge given time
console.assert(Math.abs(sim({lifeLength: 10}).terminal - 20) < 1e-3, 'no convergence');
console.log('ok');
```

---

## 8. What is *not* pinned down

- **§3.1 "Reduction from angle difference"** in diepindepth is explicitly unproven by its author. It affects tank steering (turning while moving), not projectiles — no projectile in the game applies it.
- **Rect (maze wall) knockback** is marked "haven't fully looked into yet" upstream. diepcustom's axis-snap version is a reconstruction, not a confirmed dump.
- **Shape velocity** (how squares/triangles drift) was never fully characterised.
- The **client's** interpolation/extrapolation between the 25 Hz snapshots is a separate system; nothing here describes what the client draws between ticks, only what the server simulates.
- diepcustom pins build `6f59094d60f98fafc14371671d3ff31ef4d75d9e`. Live diep.io has shipped balance changes since; the *integrator* (§1) is stable, the per-tank constants in §7 may have drifted.

---

## 9. If you're porting this

Order matters more than the constants. Per tick, per entity: **move → friction → accelerate**, in that order, with a fixed 40 ms step. Get that wrong and every range number in §7 is off by a few percent no matter how right your `speed` table is. The rest is: one `0.9`, one `+30`, one `×10` relating acceleration to max speed, and `75 · lifeLength` ticks of life.

---

*Compiled 2026-08-19 from the sources in the table at the top.*

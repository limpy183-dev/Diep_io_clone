# Diep.io — Complete Constants Reference

Short answer: **yes, for essentially everything the server simulates.** The game was reverse engineered out of its WASM binary and live memory; the numbers below are recovered values, not estimates. §14 lists the handful of things that genuinely are *not* pinned down.

Companion doc: [PROJECTILE_PHYSICS.md](PROJECTILE_PHYSICS.md) — the per-tick movement integrator and every projectile type. Not repeated here.

**Per-tank data is already in this repo** at [data/tankdefs.json](data/tankdefs.json) — 54 tank definitions, every barrel, every bullet field. This document covers everything *not* in that file.

## Source reliability

| Tier | Source | What it gives |
|---|---|---|
| A — dumped from the game | [diepindepth `physics/README.txt`](https://github.com/ABCxFF/diepindepth/blob/main/physics/README.txt), [`memory/structs/*.h`](https://github.com/ABCxFF/diepindepth/tree/main/memory/structs), [`protocol/*`](https://github.com/ABCxFF/diepindepth/tree/main/protocol) | Struct layouts, physics formulas, wire format |
| A — measured off the canvas | [diepindepth `canvas/*`](https://github.com/ABCxFF/diepindepth/tree/main/canvas) | Colors, shape draw radii, scaling algorithm |
| B — reference implementation | [diepcustom `src/`](https://github.com/ABCxFF/diepcustom/tree/main/src) (build `6f59094d…`) | Everything else; agrees with tier A where they overlap |
| C — community summary | [diepindepth `extras/stats.md`](https://github.com/ABCxFF/diepindepth/blob/main/extras/stats.md) | Player-facing stat descriptions; **conflicts in one place, see §14** |

Units: **du** = diep world units, **t** = tick. `P` = points in the stat, `L` = level, `M` = the per-barrel multiplier from `tankdefs.json`.

---

## 1. Engine

| Constant | Value |
|---|---|
| Tick length | **40 ms** → **25 ticks/second** |
| Simulation | Fully integer-tick. No delta-time anywhere. |
| Friction | **`v *= 0.9` every tick, every entity**, no exceptions |
| Max speed ↔ acceleration | `maxSpeed = 10 × acceleration` (falls out of the 0.9) |
| Velocity dead-stop | `if (|v| < 0.01) v = 0` |
| Collision shape | Circle for everything except maze walls / bases / arena (AABB). Rect-vs-rect is **not implemented** in the real game. |
| Arena (FFA, 2TDM, 4TDM, Domination, Mothership, Tag) | **22300 × 22300 du**, centred on origin |
| Arena (Maze) | 40 cells × 635 du = **25400 × 25400 du** |
| Arena (Survival) | `floor(25 · √playerCount) · 100` du, square |
| Arena padding (soft border) | **200 du** |
| Grid square (background) | **50 du** |
| Max player level | **45** |
| Boss spawn attempt interval | every **45 min** (`45 · 60 · 25` ticks) |
| Scoreboard update | every **1 s** |
| Shiny shape chance | **1 / 1 000 000** |
| Factory spawn chance (spawn out of an allied Factory) | **0.05** |
| Countdown before start | 10 s |

Per-tick order for one entity is **`applyPhysics()` (move → friction) then `tick()` (accelerate)**; the whole-game order is `preTick → client inputs → collision pairs → per-entity physics+tick → postTick`. Getting this order wrong shifts every distance by a few percent.

---

## 2. Progression

```
scoreAtLevel[1] = 0
scoreAtLevel[n] = scoreAtLevel[n−1] + (40/9) · 1.06^(n−2) · min(31, n−1)

statPoints(L) = 0            L ≤ 0
              = L − 1        1 ≤ L ≤ 28
              = ⌊L/3⌋ + 18   L > 28

sizeFactor(L) = 1.01^(L−1)
FOV(L)        = 0.55 · fieldFactor / 1.01^((L−1)/2)     (client zoom; 0.35 while spectating/menu)
```

| Level | 1 | 5 | 10 | 15 | 20 | 25 | 28 | 30 | 35 | 40 | 45 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| score | 0 | 50 | 275 | 788 | 1758 | 3434 | 4926 | 6185 | 10369 | 16001 | **23537** |
| stat points | 0 | 4 | 9 | 14 | 19 | 24 | 27 | 28 | 29 | 31 | **33** |
| size factor | 1.000 | 1.041 | 1.094 | 1.149 | 1.208 | 1.270 | 1.308 | 1.335 | 1.403 | 1.474 | **1.549** |
| FOV (ff = 1) | .5500 | .5392 | .5259 | .5130 | .5004 | .4881 | .4809 | .4761 | .4644 | .4530 | **.4419** |

33 points over 8 stats capped at 7 each (56 max) — you can never max everything.

**Class unlock levels:** 15, 30, 45 (`levelRequirement` in `tankdefs.json` is only ever 0, 15, 30, 45).

**`fieldFactor`** (zoom-out multiplier per tank) — the only values in the game are `1` (default), `0.9` (Sniper, Overseer, Overlord, Necromancer, Manager, all Trappers, Smasher, Landmine, Auto Trapper, Battleship, Auto Smasher, Spike, Factory, Skimmer, Rocketeer), `0.85` (Hunter, Predator, Streamliner), `0.8` (Assassin, Stalker), `0.7` (Ranger).

---

## 3. The eight stats

Two layers here, and mixing them up is the single most common error in diep clones. The server stores a **raw** value; collisions then multiply it by a **damage multiplier** that depends on *what hit what* (§4). Player-facing wiki formulas quote the *effective* number.

| Stat | Raw server formula | Effective / player-facing |
|---|---|---|
| **Max Health** | `def.maxHealth + 2·(L−1) + 20·P` | same (`def.maxHealth` = 50 for every tank; 6000 for Dominator) |
| **Health Regen** | `regenPerTick = maxHealth·(4P + 1) / 25000` | `0.1% + 0.4%·P` of max HP per second |
| **Hyper regen** | after 750 ticks (30 s) undamaged: `+maxHealth/250` per tick | +10% of max HP per second, stacks with base |
| **Body Damage** | `damagePerTick = P + 5 + def.bodyDamage` | vs shape (×4): `4P + 20` · vs tank (×6): `6P + 30` |
| **Bullet Damage** | `damagePerTick = (7 + 3P) · M` | same |
| **Bullet Penetration** | `maxHealth = (1.5P + 2) · M` | `(8 + 6P) · M` — 4× the raw value, because bullets take ¼ damage (§4) |
| **Bullet Speed** | `A = (20 + 3P) · M` du/t, terminal | `(500 + 75P)·M` du/s = `(10 + 1.5P)·M` grid-squares/s ⚠ see §14 |
| **Reload** | `reloadTime = 15 · 0.914^P` ticks, × `barrel.reload` | shots/s = `25 / (15·0.914^P · barrel.reload · (1+delay))` |
| **Movement Speed** | `accel = def.speed · 2.55 · 1.07^P / 1.015^(L−1)` du/t | max speed = 10 × that |

`def.speed` is **1.0 for every single tank** in the game — movement speed is not class-differentiated. `def.bodyDamage` is **0 for every tank except Spike (+2)**.

Reload at a glance (ticks per shot, `barrel.reload = 1`): P=0 → 15.00, P=1 → 13.71, P=2 → 12.53, P=3 → 11.45, P=4 → 10.47, P=5 → 9.57, P=6 → 8.74, P=7 → **7.99**.

**Stat colours (upgrade menu):** Health Regen `#fcad76`, Max Health `#f943ff`, Body Damage `#8543ff`, Bullet Speed `#437fff`, Bullet Penetration `#ffde43`, Bullet Damage `#ff4343`, Reload `#82ff43`, Movement Speed `#43fff9`. Stat enum order on the wire: MovementSpeed 0, Reload 1, BulletDamage 2, BulletPenetration 3, BulletSpeed 4, BodyDamage 5, MaxHealth 6, HealthRegen 7.

---

## 4. The damage multiplier system

Every damaging entity carries `damagePerTick`, `minDamageMultiplier`, `maxDamageMultiplier`, `damageReduction`. On a collision:

```
common = max(a.minDamageMultiplier, b.minDamageMultiplier)
       × min(a.maxDamageMultiplier, b.maxDamageMultiplier)

damage a→b = a.damagePerTick · common · b.damageReduction
```

then both sides are scaled down by the health/damage ratio so neither over-kills (mutual-kill rule).

| Entity | damagePerTick | minMult | maxMult | damageReduction |
|---|---|---|---|---|
| Tank body | `P + 5 (+2 Spike)` | 1 | **6** | 1 (0 while spawn-protected/invulnerable) |
| Bullet / trap | `(7 + 3P) · M` | **0.25** | **1** | 1 |
| Drone, necro square | `(7 + 3P) · M` | **1** | 1 (necro: **4**) | 1 |
| Flame | — | — | — | ramps **1 → 2 over 25 ticks** |
| Shape (all) | see §5 | 1 | **4** | 1 |
| Team base | 5 | 1 | 1 | 0 |
| Boss | 10 | 1 | 4 | 1 |
| Arena Closer | 45 | 1 | 4 | 1 |
| Dominator | 10 | 1 | 4 | 1 |

This is where `4P + 20` (tank vs shape: `min(6,4) = 4`) and `6P + 30` (tank vs tank: `min(6,6) = 6`) come from, and why "bullets have 75% damage reduction" is really `minDamageMultiplier = 0.25` on both bullets in a bullet-vs-bullet pair.

### Knockback

```
impulse on A = A.absorbtionFactor × B.pushFactor      [du/t added to velocity, along A−B]
bullet: absorbtionFactor = M_abs;  pushFactor = (7/3 + P_dmg) · M_dmg · M_abs
```

| Entity | pushFactor | absorbtionFactor |
|---|---|---|
| default (tank, shape, most) | 8.0 | 1.0 |
| Mothership, bosses | 8.0 | 0.01 |
| Arena Closer | 8.0 | 0.0 |
| Maze wall / team base | 2.0 | 0.0 |
| Crasher (small) | 12.0 | 2.0 |
| Crasher (large) | 12.0 | 0.1 |
| Pentagon | 11.0 | 0.5 |
| Alpha Pentagon | 11.0 | 0.05 |
| Drone (incl. factory, necro) | 4.0 | from barrel def |
| Dominator | — | 0.0 |

Barrel `absorbtionFactor` values in `tankdefs.json` are 1.0 almost everywhere; the exceptions are Destroyer/Skimmer/Rocketeer/Auto-rocket `0.1` and Annihilator `0.05`.

---

## 5. Shapes

| Shape | HP | collision radius | draw radius | sides | damage/tick | score | push | absorb |
|---|---|---|---|---|---|---|---|---|
| Square | 10 | `55/√2` = 38.891 | 55 | 4 | 2 | 10 | 8 | 1 |
| Triangle | 30 | `55/√2` = 38.891 | 55 | 3 | 2 | 25 | 8 | 1 |
| Pentagon | 100 | `75/√2` = 53.033 | 75 | 5 | 3 | 130 | 11 | 0.5 |
| Alpha Pentagon | 3000 | `200/√2` = 141.421 | 200 | 5 | 5 | 3000 | 11 | 0.05 |
| Crasher (small) | 10 | `35/√2` = 24.749 | 35 | 3 | 2 | 15 | 8 | 2 |
| Crasher (large) | 30 | `55/√2` = 38.891 | 55 | 3 | 2 | 25 | 12 | 0.1 |

All shapes: `maxDamageMultiplier = 4`. **Shiny** (1-in-a-million, not for alphas): HP ×10, score ×100.

### Shape drift — this is what diepindepth's §3.4 left blank

Shapes are not static. Every tick a non-crasher shape runs:

```
positionData.angle += rotationRate           // spin
orbitAngle         += orbitRate              // slow curve of travel
maintainVelocity(orbitAngle, shapeVelocity)  // then the normal integrator
```

| | rotationRate | orbitRate | shapeVelocity (max speed) |
|---|---|---|---|
| Square, Triangle, Crasher | ±0.01 rad/t | ±0.005 rad/t | 1 du/t (25 du/s) |
| Pentagon, Alpha Pentagon | ±0.005 rad/t | ±0.0025 rad/t | 0.5 du/t |

Signs are randomised ±per shape at spawn. Within 400–500 du of the arena edge the shape picks a new `orbitAngle` and turns toward it over a `TURN_TIMEOUT` of 300 ticks, at 10× orbit rate until within 0.20 rad.

**Crashers** override this: `viewRange = 2000 du`, retarget once per second, and while chasing they add `movement · targettingSpeed` to velocity directly — **2.602 du/t small, 2.640 du/t large** — and pass through maze walls.

### Spawn distribution

Position is uniform random in the arena, then the **zone decides the shape**:

| Zone | Test (arena half-width `R`) | Spawns |
|---|---|---|
| Pentagon Nest | `max(x,y) < R/10 && min(x,y) > −R/10` (centre) | Pentagon, **5%** chance Alpha |
| Crasher Zone | `max(x,y) < R/5 && min(x,y) > −R/5` | Crasher, **20%** chance large |
| Fields | everywhere else | 4% Pentagon, 16% Triangle, **80% Square** |

Target population: **1000 shapes** in a standard 22300 arena (Survival: `⌊12.5 · ⌈(width/2500)²⌉⌋`). Score rewards are multiplied by the arena's `shapeScoreRewardMultiplier`: FFA/TDM **1×**, Domination **2×**, Mothership **3×**, Survival **3×**.

---

## 6. Tank body

| | Value |
|---|---|
| Base radius, 1-sided (most tanks) | **50 du** |
| Base radius, 4-sided (Necromancer, Factory) | `32.5√2` = **45.962 du** |
| Base radius, 16-sided (Mothership) | `25√2` = **35.355 du** |
| Actual radius | `baseRadius × 1.01^(L−1)` |
| Border width | 15 (140 for the 16-sided) |
| Base max health | 50 |
| Spawn protection | `damageReduction = 0`, style flag `isFlashing`, until first input |
| Barrel recoil on shooter | `2 × barrel.recoil` du/t impulse, opposite the barrel |
| Necromancer claim cap | `11 + reloadStat` squares **per barrel** |

**Invisibility** (only three tanks have it):

| Tank | +opacity/tick shooting | +opacity/tick moving | −opacity/tick idle |
|---|---|---|---|
| Stalker | 0.23 | 0.08 | 0.03 |
| Manager | 0 | 0.08 | 0.03 |
| Landmine | 0 | 0.16 | 0.003 |

Taking damage also adds **+0.2 opacity** (`visibilityRateDamage`), once per tick. Predator is the only tank with `zoomAbility`.

**Death animation** (every entity): 5 ticks of `scale ×1.1`, `opacity −1/6`, `velocity /2` per tick, deleted on the 6th.

---

## 7. Addons

`createGuard(sides, sizeRatio, offsetAngle, radiansPerTick)` — a decorative/collision polygon at `ownerRadius × sizeRatio`.

| Addon | Guards |
|---|---|
| `smasher` | 6 sides, 1.15×, 0 rad, **0.10 rad/t** |
| `landmine` | 6 @ 1.15 @ 0.10 **and** 6 @ 1.15 @ 0.05 (the beat frequency is the visual) |
| `autosmasher` | smasher guard + one centred Auto Turret |
| `spike` | 4 × (3 sides, 1.3×, **0.17 rad/t**) at offsets 0, π/6, π/3, π/2 |
| `dombase` | 6 sides, 1.24×, 0 rad/t |
| `spiesk` (not in real diep) | 3 × (4 sides, 1.3×, 0.17) at 0, π/6, 2π/6 |
| `weirdspike` (not in real diep) | 3 @ 1.5 @ +0.17 and 3 @ 1.5 @ −0.16 |

Auto-turret rings: `auto3` / `auto5` place `N` turrets at `ownerRadius × 0.8`, evenly spaced, base radius 25.
Flat overlays: `launcher` (Rocketeer/Twister) trapezoid `65.5√2/50 × radius` long, `33.6/50 × radius` wide; `pronounced` (Ranger) `50/50 × 42/50` at `0.8 × radius`; `dompronounced` `22/50 × 35/50` at `1.0 × radius`.

### Auto Turret (the default one on Auto 3/5, Auto Gunner, Auto Trapper, …)

```
size 55, width 29.4, reload 1, recoil 0.3, delay 0.01, base radius 25
bullet: health 1, damage 0.3, speed 1.2, scatterRate 1, lifeLength 1, sizeRatio 1, absorbtion 1
AI: viewRange 1700 du (the default — AutoTurret does not override it), doAimPrediction on,
    aimSpeed = its bullet terminal speed
```

Auto-rocket variant: `size 40, width 26.25, reload 2, recoil 0.75, trapezoid`, bullet `type rocket, health 2.5, damage 0.5, speed 0.3, lifeLength 0.75, absorbtion 0.1`.

### AI constants (drones, auto turrets, crashers, bosses)

| | Value |
|---|---|
| `PASSIVE_ROTATION` (idle sweep) | 0.01 rad/t |
| default `viewRange` (incl. **auto turrets** — they never override it) | 1700 du |
| drone / minion `viewRange` | 900 du |
| swarm `viewRange` | 2000 du |
| crasher / boss `viewRange` | 2000 du |
| Arena Closer `viewRange` | ∞ |
| retarget interval | every 2 ticks (crashers: 25; bosses: every tick) |
| target retention | keeps current target while within `viewRange²·2` |
| lead prediction | `offset = (v⊥ / v∥ · dist) / 2` — deliberately **half** the correct lead |
| drone resting radius | 400 du (accel ÷6 inside, ÷3 within half) |
| minion focus radius | 800 du (flee < 302 du, strafe < 800 du, else approach) |

---

## 8. Bosses

Common: `maxHealth 3000`, `damagePerTick 10`, `absorbtionFactor 0.05`, `scoreReward 30000 × shapeScoreMultiplier`, `reloadTime = 15·0.914⁷ ≈ 7.99` ticks, `regenPerTick = maxHealth/25000`, `viewRange 2000`, movement speed 0.5 (max 5 du/t) unless overridden.

| Boss | sides | draw radius | collision radius | movement speed | note |
|---|---|---|---|---|---|
| Guardian | 3 | 135 | `135/√2` = 95.46 | 0.5 | one drone spawner |
| Summoner | 4 | 150 | `150/√2` = 106.07 | 0.5 | 4 drone barrels |
| Defender | 3 | 150 | `150/√2` = 106.07 | **0.2** | `viewRange 0`, 3 trap barrels + 3 mounted auto turrets, 2× passive rotation |
| Fallen Overlord | 1 | — | `50 · 1.01^74` = 104.41 | 0.5 | Overlord barrels, overridden to `droneCount 7, reload 0.36, sizeRatio 0.5, speed 1.7, damage 0.56, health 12.5` |
| Fallen Booster | 1 | — | `50 · 1.01^74` = 104.41 | **1.0** | Booster barrels, overridden to `speed 1.7, health 6.25, damage ×0.8` |

The two Fallen tanks are literally player tanks scaled to level 75 (`1.01^74`); Guardian/Summoner/Defender are custom shapes sized like §5's shapes (draw radius, collide at `/√2`).

Spawn attempt every 45 minutes, one boss at a time, uniformly chosen from the five.

## 9. Other entities

| Entity | HP | radius | damage/tick | notes |
|---|---|---|---|---|
| Arena Closer | 10000 | 175 base (`×3.5` size factor) | 45 | speed 5 du/t, `absorbtionFactor 0`, invulnerable, ∞ view range, passes through walls |
| Dominator | 6000 | 160 | 10 | immobile (`speed 0`), `absorbtionFactor 0`, no score reward, full-heal on capture |
| Mothership | 7000 | 16-sided tank | — | `absorbtionFactor 0.01`, no score reward |
| Team base | `0xABCFF` | rectangle | 5 (0 on own team) | `pushFactor 2`, `absorbtionFactor 0`, `damageReduction 0`, opacity 0.1 |
| Maze wall | — | rectangle | — | `pushFactor 2`, `absorbtionFactor 0`, borderWidth 10; enemy projectiles **die** on contact |

**Maze generation:** 40×40 grid, cell 635 du, `baseSeedCount 45`, `seedCountVariation 30`, `turnChance 0.2`, `branchChance 0.2`.
**Domination:** arena 22300, base region `arenaSize/(3+1/3)` = 3345 du, dom base half that.
**2 Teams:** base width `arenaSize/(3+1/3)·0.6` ≈ 2007 du.

---

## 10. Colors

18 IDs on the wire. Stroke is the fill darkened (the client multiplies toward black; UI buttons darken by exactly −51 per channel).

| ID | Name | Fill | Stroke |
|---|---|---|---|
| 0 | Border | `#555555` | — |
| 1 | Barrel / Cannon | `#999999` | `#727272` |
| 2 | Tank (you) | `#00b2e1` | `#0085a8` |
| 3 | Team Blue | `#00b2e1` | `#0085a8` |
| 4 | Team Red | `#f14e54` | `#b43a3f` |
| 5 | Team Purple | `#bf7ff5` | `#8f5fb7` |
| 6 | Team Green | `#00e16e` | `#00a852` |
| 7 | Shiny | `#8aff69` | — |
| 8 | Square | `#ffe869` | `#bfae4e` |
| 9 | Triangle | `#fc7677` | `#bd5859` |
| 10 | Pentagon | `#768dfc` | `#5869bd` |
| 11 | Crasher | `#f177dd` | `#b459a5` |
| 12 | Neutral | `#ffe869` | — |
| 13 | Scoreboard bar | `#43ff91` | — |
| 14 | Box / wall | `#bbbbbb` | — |
| 15 | Enemy tank | `#f14e54` | `#b43a3f` |
| 16 | Necromancer square | `#fcc376` | — |
| 17 | Fallen (boss) | `#c0c0c0` | — |

UI: grid `#cdcdcd` on `#000000`, minimap bg `#cdcdcd` / border `#555555`, score bar `#43ff91`, level bar `#ffde43`, health bar `#85e37d`, out-of-arena fill `#000000`, name `#ffffff` (cheat-flagged names `#ffff90`), text stroke `#000000`.

---

## 11. Client rendering

```js
windowScaling() {                       // canvas, not window.inner*
  const a = canvas.height / 1080, b = canvas.width / 1920;
  return b < a ? a : b;
}
scalingFactor = FOV * windowScaling()   // canvas pixels per diep unit
gridOpacity   = scalingFactor * 0.1
```

Shapes are drawn by **radius to a vertex**, not side length, which is why the draw radius and the collision radius differ by `√2/2` in §5.

Render order: grid → borders → leader arrow → mothership arrows → entities → names → health bars → UI (server stats → scoreboard → minimap → status bars → attribute upgrades → class tree → achievements).

---

## 12. Protocol

Field groups by ID: `0 RELATIONSHIPS, 2 BARREL, 3 PHYSICS, 4 HEALTH, 7 ARENA, 8 NAME, 9 GUI, 10 POS, 11 STYLE, 13 SCORE, 14 TEAM` (1, 5, 6, 12 deleted/unused). **68 fields total, shuffled per build** — field indices are build-specific, group-relative IDs are stable. Entities are `<id, hash>` pairs; `hash = 0` means deleted.

Tank IDs and stat IDs are XOR-obfuscated with a magic number derived from the 40-hex-char build hash. Full wire format: [diepindepth/protocol](https://github.com/ABCxFF/diepindepth/tree/main/protocol). Achievement list: [diepindepth/extras/achievements.json](https://github.com/ABCxFF/diepindepth/blob/main/extras/achievements.json).

---

## 13. Where every remaining number lives

| You want | Look at |
|---|---|
| Any per-tank / per-barrel / per-bullet number | [data/tankdefs.json](data/tankdefs.json) — already in this repo |
| Projectile motion, ranges, lifetimes | [PROJECTILE_PHYSICS.md](PROJECTILE_PHYSICS.md) |
| Addon render geometry beyond §7 | [diepindepth/extras/addons.md](https://github.com/ABCxFF/diepindepth/blob/main/extras/addons.md) |
| Achievements | [diepindepth/extras/achievements.json](https://github.com/ABCxFF/diepindepth/blob/main/extras/achievements.json) |
| Wire format, packet layouts | [diepindepth/protocol](https://github.com/ABCxFF/diepindepth/tree/main/protocol) |

---

## 14. Conflicts and genuine unknowns

**Conflicts** — where two sources disagree and I picked one:

1. **Bullet speed.** `extras/stats.md` says `(5 + 4P) · M` grid-squares/second (= `10 + 8P` du/t). `physics/README.txt` and the implementation say `(20 + 3P) · M` du/t (= `10 + 1.5P` squares/s). These are irreconcilable — not a unit or multiplier difference. I use the physics/implementation value: it is self-consistent with the +30 du/t launch impulse, the 0.9 friction, and the observed ~3 s / ~1795 du basic-bullet range. Treat `stats.md`'s line as the odd one out.
2. **Spike body damage.** diepindepth says Spike deals a flat 50% more (`9P + 30`). The implementation gives it `def.bodyDamage = +2`, i.e. `(P+7)` raw → 1.40× at P=0 falling to 1.17× at P=7. Not a flat 1.5×. Unresolved; the `+2` at least reproduces the right ballpark at mid-investment.
3. **Reload.** `BarrelDefinition.h`'s comment says `ceil((15 − reloadPoints) · baseReload)` — that's a linear model and it is wrong/stale. The real curve is geometric: `15 · 0.914^P`.
4. **Bullet damage per tick.** diepindepth §5.2.2 writes `(7 + B_D·3) · b_DS`, swapping the stat and the definition constant. Correct: `(7 + 3·statPoints) · def.damage`.

**Genuinely not pinned down:**

- **Rect (maze wall) knockback** — diepindepth marks it "haven't fully looked into yet". The axis-snapping implementation is a plausible reconstruction, not a dump.
- **"Reduction from angle difference"** on tank movement — diepindepth's author explicitly declines to explain it because he didn't derive it. Affects steering while moving; no projectile uses it.
- **Reload §6.1** in the physics doc is an empty stub; the `0.914^P` curve comes from elsewhere and is well corroborated, but the *shoot-cycle* edge cases (what `delay` does on a reload change mid-cycle) are reconstruction.
- **Hit-flash animation** — the exact red-tint curve when an entity takes damage was never worked out.
- **Client interpolation/extrapolation** between the 25 Hz snapshots — a separate system, undocumented. Nothing here describes what you see between ticks.
- **Field index shuffling** is regenerated per build, so any hard-coded protocol index is version-locked.
- **Live drift.** These values are from build `6f59094d60f98fafc14371671d3ff31ef4d75d9e`. The engine (§1) is stable across builds; individual balance constants may have moved since.

---

*Compiled 2026-08-19.*

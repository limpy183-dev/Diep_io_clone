# Tank Arena

A browser tank-arena game built to the attached reverse-engineering spec: exact tick rate,
exact formulas, the real class tree, and the real balance data.

## Run

**Single player** needs nothing at all — open `index.html` and hit *Play Offline*.
No build step, no install, no server.

**Multiplayer:**

```bash
npm install && npm start
```

Then open `http://localhost:8137` and hit *Play Online*. The server hosts the game
files too, so everyone points at the same address. To play across machines, give
others your LAN address (`ws://192.168.x.x:8137`) in the server box.

Run the tests:

```bash
npm test
```

## What's here

| File | |
|---|---|
| `js/tankdefs.js` | The tank table, generated from `data/tankdefs.json`. Never hand-edit. |
| `js/tankdefs-extra.js` | Seven tanks not in that dump; patches the table at load |
| `js/data.js` | Constants, palette, XP curve, shapes, addons, bosses, game modes |
| `js/engine.js` | 25 Hz simulation: entities, physics, damage, barrels, projectiles, AI, bots |
| `js/modes.js` | The five objective modes + possession (H) |
| `js/protocol.js` | Binary wire format, shared by client and server |
| `js/net.js` | Client-side world mirror + snapshot interpolation |
| `js/render.js` | Canvas 2D drawing + HUD |
| `js/commands.js` | The chat command table, shared by client and server |
| `js/chat.js` | Chat overlay (DOM) + the client half of the command dispatch |
| `js/main.js` | Input, fixed-timestep loop, menu |
| `server.js` | Authoritative game server (also serves the static files) |
| `test.mjs` | 73 simulation tests |
| `test-net.mjs` | 38 network tests against a live server |

## Chat and commands

**T** or **Enter** opens the chat box in the top-left; **/** opens it with a slash already
typed. Tab completes a command name, Up walks back through what you have sent, Esc closes.
Bots chatter on their own, so the log is never empty.

Commands live in one table in `js/commands.js` that both sides load — offline the browser
runs an entry against its own `Game`, online the server runs the identical entry against the
authoritative one, then broadcasts the result. Three flavours:

- **Local** (`/help`, `/clear`, `/mute`, `/fps`, `/ping`, …) never leave the browser.
- **World** (`/me`, `/roll`, `/w`, `/players`, `/nick`, …) run wherever the world is.
- **Cheats** (`/god`, `/max`, `/class`, `/tp`, `/boss`, `/nuke`, `/army`, `/rain`, `/disco`,
  `/timewarp`, `/view`, … 47 of them) are gated on `ctx.sandbox`: always allowed
  offline, online only inside a Sandbox arena. The gate is checked by whoever owns the world, so a client cannot cheat
  its way past it. `/help` lists everything, `/cheats` lists just those.

## Objective modes

Each lives in `js/modes.js` as an `init` / `tick` / `onTankDeath` / `reset` entry that the
engine dispatches on by name. Winning a round posts a banner, then resets the objectives and
respawns everyone rather than tearing the arena down.

| Mode | Teams | XP | How you win |
|---|---|---|---|
| **Domination** | 2 | ×2 | Hold all four Dominators |
| **Tag** | 4 | ×3 | Every living player ends up on your team |
| **Mothership** | 2 | ×3 | Destroy the enemy Mothership |
| **Breakout** | 2 | ×2 | Claim the whole 8×8 board |
| **Capture the Flag** | 2 | ×1 | Capture all 10 enemy flags |

- **Domination** — four 6,000 HP Dominators (Destroyer/Gunner/Trapper flavours, taken from the
  real tank table) sit bolted down at the centre. Kill a neutral one to capture it; kill an
  enemy-held one and it reverts to neutral first, so taking ground costs two fights. They never
  actually die — they revive in place under the new owner, dropping their projectiles and
  ejecting any pilot.
- **Tag** — dying to a player moves you onto *their* team; dying to a shape does not. The arena
  slowly shrinks, and invisibility is capped at 25 % opacity so nobody can stall the round out.
- **Mothership** — one 16-sided, 16-barrelled Mothership per team, immovable, flying itself
  until a pilot takes over. The wheel passes to the team's highest scorer every 5 minutes.
- **Breakout** — you can only claim ground that touches ground you already hold, so the front
  advances rather than teleporting. Camp your own tile for 30 s and it flashes, then collapses
  and kills you.
- **Capture the Flag** — a barrier splits the map for the first 5 minutes. Touch an enemy flag
  to carry it, reach your base to score; dying drops it straight back home.

**Press H** to take control of a Dominator or Mothership your team holds, and again to step
out. Piloting *parks* your own tank rather than destroying it — you keep your score and get it
back where you left off. Parked tanks have no collider and are never sent to other clients.

The scoreboard adapts: objective modes replace the player list with a per-team tally (Tag shows
player counts, Breakout territory %, Mothership hull %, CTF captures) using the same packet.

## Retiring a server

`Ctrl+C`, `SIGTERM`, or `node server.js <port> <closeAfterSeconds>` starts the shutdown
sequence rather than dropping players mid-match:

1. Every arena announces *"Arena closed: No players can join"* and stops respawning bots.
   New joins are routed to a fresh arena, so the closing one drains without blocking anyone.
2. `floor(sqrt(arenaWidth)/10)` Arena Closers — **14** for a 22300 arena — spawn evenly
   around a circle of radius `arenaWidth x sqrt(1/2) + 5000` (~20770, outside the field),
   each facing inward, and sweep everything off the board.
3. Once nothing but closers remains the arena reports CLOSED, stragglers are moved off with
   a message explaining why, and the process exits when the last arena is empty.

Closers are invincible, move at ~200 units/tick, pass through walls, one-shot on contact,
ignore each other, and **see invisible tanks** — a Stalker cannot wait one out. They never
appear on the scoreboard, which with fewer than 10 alive naturally lists only survivors.

A spawn-protected idler is immune for its full 15 seconds and will delay the sweep that long.
That is correct, not a bug — protection lapses the moment they move or shoot.

A second `Ctrl+C` exits immediately.

## Multiplayer design

**The client owns nothing.** It sends inputs and draws snapshots. Every piece of
damage, XP, levelling, stat spend and class upgrade happens on the server, which
re-validates each request against the same rules the offline game uses. The tests
spam 120 stat-upgrade packets and confirm the server grants exactly the number of
points the player's level actually permits.

The renderer is shared verbatim. `js/net.js` rebuilds a *Game-shaped* object from
snapshots, so `render.js` cannot tell an online match from an offline one — there
is no networked-vs-local branching anywhere in the drawing code.

**Wire format.** A typical view is ~150 entities at 25 Hz. As JSON that is roughly
1.2 Mbps; packed into the binary format in `js/protocol.js` it is about 390 kbps.
Positions ride as `int16` (the arena fits in ±11350), angles as one byte.

Two things deliberately do *not* go over the wire, because both ends already have
the tank table: **barrel geometry** (the client rebuilds every barrel from a one-byte
tank id) and **turret counts** (derived from the class, so only angles ship).

Fully invisible tanks are never sent to other clients at all, so a Stalker cannot be
revealed by inspecting network traffic.

**Arenas** are created per game mode on first join and released a minute after the
last player leaves. Bots thin out as real players arrive, so a busy server is mostly
humans and an empty one still feels alive.

Regenerate the tank table:

```bash
curl -Lo data/tankdefs.json https://raw.githubusercontent.com/ABCxFF/diepcustom/main/src/Const/TankDefinitions.json
node -e "const fs=require('fs');fs.writeFileSync('js/tankdefs.js','var TANK_DEFS = '+fs.readFileSync('data/tankdefs.json','utf8')+';\nif(typeof module!==\"undefined\")module.exports=TANK_DEFS;\n')"
```

## Implemented

- **Simulation** — 40 ms tick, force-based physics with 10 % linear damping, spatial hash
  broadphase (cell 128), circle/rect collision, axis-snapped knockback, 5-frame death pop.
- **Damage** — the real two-way `min`/`max` multiplier model with no-overkill scaling.
  Body damage, penetration-as-bullet-HP, the 75 % bullet-vs-bullet reduction, and the
  drone exception all fall out of the table rather than being special-cased.
- **Progression** — exact XP curve, 33 points at level 45, `1.01^(L-1)` scaling,
  `1.015^(L-1)` speed penalty, FOV curve, sqrt respawn level, spawn protection, hyper-regen.
- **61 tank classes** driven entirely by data — every barrel angle, offset, reload, recoil
  and projectile descriptor is a table row. Addons (smasher/landmine/spike hulls,
  auto-turret rigs, trapper hoods, dominator plinths) are composed, not coded.
  54 come from the canonical dump; the seven added later live in `js/tankdefs-extra.js`,
  which patches the generated table at load so re-fetching the dump never clobbers them.
  Six of those seven have their multipliers *solved* from published per-point figures
  against the engine's own formulas rather than guessed — see the note at the top of that
  file. The seventh is flagged below.
- **Projectiles** — bullets, drones (controllable + idle orbit), necromancer square capture,
  traps, minions, skimmer/rocket missiles that carry their own barrels, swarms.
- **Shapes** — exact HP/XP/size, zone-based spawn mix (nest → crasher ring → 80/16/4 field),
  idle drift with edge steering, crasher AI, 1-in-a-million shiny variants.
- **AI** — one targeting class with retarget cadence, hysteresis, and the cheap
  perpendicular-drift intercept solver, shared by turrets, drones, crashers and bosses.
- **All 5 bosses**, 45-minute spawn cycle, one-at-a-time rule, 30 000 XP.
- **All 10 game modes** — FFA, 2 Teams, 4 Teams, Maze (generated walls), Sandbox (+ cheats),
  plus the five objective modes below. Team bases with drone spawners, enemy-projectile
  dissolve, and rammer ejection.
- **UI** — scoreboard, score/level bars, stat panel with queueing, upgrade cards, minimap,
  leader arrow, notifications, class-tree overlay, death screen with killer attribution.
- **Chat** — top-left overlay, arena-wide online, 74 slash commands including a cheat set
  that only unlocks offline or in a Sandbox arena. See above.
- **28 bots** with build orders and class choices, so the leaderboard is alive. *Play
  Offline* opens a difficulty picker first — Easy through Extreme, or Custom, which
  exposes the six skill dials (aim, reflexes, dodging, footwork, aggression, game sense)
  and the bot count. The setting is also reachable from the menu's *change* link and from
  `/difficulty <name>` in chat. Bots lead their shots, strafe, dodge incoming fire, pick
  targets on threat rather than proximity, retreat when hurt, and space themselves by
  their own weapon's reach — how much of that they do is what the difficulty sets.

## Deliberately not built

In rough order of effort:

- Removed tanks (Mega Smasher, the original two-cannon Predator, X Hunter, Auto 4) are
  deliberately absent, as are the dev-only and non-selectable ids (Arena Closer Protector,
  ID 53).
- **Dev console** (`net_replace_color`), achievements, gamepad, mobile touch sticks.
- **Netcode refinements** — snapshot interpolation uses a single previous frame
  (~40 ms behind) rather than a jitter buffer, and every visible entity's fields are
  resent each tick instead of only the changed ones. Both are marked `ponytail:` in
  the source with the upgrade path. At ~390 kbps neither pays for itself yet.
- **Ops** — no accounts, party links, region routing or reconnect-on-drop. One process
  serves all arenas; there is no horizontal scaling story.

## Two places the spec contradicts itself

Both were resolved by trusting the shipped data table over hand-maintained prose, which is
what the spec itself instructs:

1. **Trapper is id 31**, not 30. The Sniper's own `upgrades` array reads `[15, 11, 19, 31]`,
   which settles it. Asserted in `test.mjs`.
2. **Stalker invisibility.** The data says `invisibilityRate: 0.03` → 1.33 s to vanish; the
   community figure is 2.2 s. Landmine's shipped rate (0.003 → 13.3 s) matches its measured
   13.0 s almost exactly, which confirms `1/rate` is the right model, so the Stalker number is
   used as shipped. Both are asserted, with the discrepancy recorded in the test.

Hexagons spawn in the Pentagon Nest alongside Pentagons and Alphas. Their HP and XP
(1500 / 1500) are confirmed; their geometry and 10% nest share never were, and both carry
`TODO` markers. The Mothership's HP was likewise never published and is set to boss-tier
3000, also marked `TODO`.

## One tank is designed, not reconstructed

**Auto Shotgun (id 66) is the only invented tank in the project.** The spec says a third
Shotgun-branch tank exists in current builds but never names it and gives no id, stats or
geometry — there was nothing to reconstruct.

Rather than invent freely, it follows a rule the shipped data already obeys: in the real
table **Auto Gunner, Auto Trapper and Auto Smasher are each their base tank's barrels
*unchanged*, plus a turret** (verified, and asserted in `test.mjs`). Auto Shotgun is Shotgun
under exactly that rule, so it inherits the published Shotgun pellet figures and adds nothing
new. Its id sits past the highest real id so it cannot collide if the canonical table is ever
updated, and it is a leaf of the tree.

If the real tank is ever documented, delete that one entry and add the real one — nothing
else depends on it.

## Bugs found and fixed

Building Auto Tank and the Glider exposed a single bad line — the recoil recipient in
`Barrel.shoot` walked `.owner` to find a tank, which is wrong twice over:

1. **Auto-turret barrels threw on every shot.** Turrets reach their tank through `.parent`,
   not `.owner`, so the walk ended on the turret itself and `root.addVelocity` was undefined.
   Every turret class — Auto 3, Auto 5, Auto Gunner, Auto Trapper, Auto Smasher and the
   Defender boss — crashed the moment a turret acquired a target. The server's `try/catch`
   around `step()` had been swallowing it as a log line.
2. **Missile recoil kicked the player.** A Rocketeer's rear barrel walked up to its owner and
   shoved the *tank* ~6 units per shot instead of propelling the missile.

Both are now one helper, `recoilTarget()`: a turret pushes the tank it is bolted to, a missile
pushes itself (that *is* its propulsion), everything else pushes itself. Rocketeer and Glider
are now driven purely by their own barrels' recoil, with no scripted thrust. Both cases are
pinned by regression tests.

Separately, missile flight times were 3x too long (Skimmer lived ~15 s against a measured ~5 s)
because an invented multiplier sat on top of `lifeLength`. Lifetimes are now explicit in
`MISSILE_LIFE`, matching the measured 5 s / 4 s / 5 s.

A later sweep for anything else outstanding turned up three more:

3. **Hexagons were dead data.** The shape was fully defined with confirmed HP and XP but no
   code path ever spawned one, so it simply did not exist in the game. Zone selection now
   lives in `Game.shapeKindAt()` — testable, and hexagons nest with Pentagons and Alphas.
4. **Breakout tile state never reached the client.** `warning` and team ownership existed
   only on the server, so online a camped tile never flashed in the world and unclaimed tiles
   drew at the wrong opacity. Both now ride spare bits in the per-entity flag byte — zero
   extra bandwidth.
5. **Dead code** — an unused local in `drawTurret`, an unused `Game.closing` field, and
   `serve.js`, which `server.js` had superseded (it serves the static files itself).

A later audit for half-wired features caught two more:

7. **The death-screen spectator camera never worked.** `render.js` read `game.spectate`
   to follow your killer, but nothing ever wrote it — dead code. The camera now locks onto
   whoever killed you (server-side too, so it works online), stays put once they die, and
   clears on respawn. Dying to a shape or an orphaned bullet leaves nothing to watch.
8. **The Firework shell drew its 16 shard barrels.** Those barrels exist only so the burst
   can reuse the normal firing path; rendering them turned the hexagonal shell into a
   16-spoke starburst. Now suppressed.

Building the close sequence caught the worst of the networking bugs:

9. **Every string on the wire was truncated to 32 characters.** `Buf.str()` applied a cap
   meant for player names to *all* strings, so every notification longer than 32 chars had
   been arriving mangled — boss announcements, Dominator captures, win banners. It surfaced
   as `'Arena closed: No players can joi'`. The cap is now the format's real 255-byte
   ceiling, and it stops on a character boundary so a multi-byte character is never split.
   Name limits live in the server's `sanitize()`, where they belong.

## Attribution

`data/tankdefs.json` is the balance table from
[DiepCustom](https://github.com/ABCxFF/diepcustom), which is **AGPL-3.0**. It is fetched as a
data asset rather than vendored into source. If you distribute this or run it as a network
service, the AGPL's terms apply to that data file — check them before publishing.

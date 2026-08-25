# Tank Arena

**A diep.io replica — and then a lot more on top of it.**

The replica half is built to the attached reverse-engineering spec and does not take
liberties: exact tick rate, exact formulas, the real class tree, the real balance data,
all five bosses, all eleven of diep's own game modes, and authoritative multiplayer with
client-side prediction. If you have played diep.io, this is that.

The other half is everything diep.io does not have. The headline is the **[Mode Lab](docs/index.html)**
— 38 extra gamemodes reached from a button on the main menu, from Gun Game and Prop Hunt to a
black hole that starts as a speck and ends by swallowing the arena. Several of them bring their
own visuals: real fog, a nightfall that actually dims your vision, an accretion disc, a
twelve-sided custom Juggernaut hull that exists in no class tree. On top of that there are 76
chat commands including a 50-strong cheat set, bot difficulty down to six individual skill
dials, 31 real community builds the bots draft from, and a class-tree wheel.

Everything still runs with no build step. Open `index.html` and play.

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

Run the tests — 923 of them:

```bash
npm test
```

`npm run test:modes` runs just the Mode Lab suite, which is the fast one.

## The Mode Lab

Press **MODE LAB** on the main menu — the button under the bot-difficulty line. It opens a wall
of 38 tiles, each one live-rendered rather than a screenshot. Click a tile and it expands into
a full-screen view with a write-up of the mode beside it, then plays offline against bots or
online against people.

There is a browsable version of the same wall at **[docs/index.html](docs/index.html)**, which
loads the game's own `js/modefx.js` so the tiles on the site are drawn by exactly the same code
as the tiles in the game. To publish it, turn on GitHub Pages with the source set to
*Deploy from a branch → main → /docs*; it then serves at
`https://<user>.github.io/<repo>/`.

| Family | Modes |
|---|---|
| **Rules** — one constant, whole new game | Chaos Rotation, Score Attack, Instagib, Vampire, Ice Rink, Blood Money, Locust |
| **The Tree** — the 56 classes are the content | Gun Game, Draft Roulette, Mirror Match, Randomizer |
| **Asymmetry** | Juggernaut, Infection, Boss Rush, Siege, Closer Gauntlet, Boss Royale |
| **Physics** — knockback over damage | Sumo, Diep Ball, Grand Prix, Red Light Green Light, Singularity |
| **Deception** | Prop Hunt, Hide and Seek, Fog of War, Nightfall |
| **Territory** | King of the Hill, Payload, Alpha Hunt, Nest Wars, Roaming Domination, Bounty King |
| **The Arena** | Labyrinth Royale, Musical Tiles, Portals |
| **Social** | Squads, Duel Bracket, Bomb Tag |

A few that are worth calling out:

- **Juggernaut** ships the only invented *hull* in the project — twelve sides, a spiked collar,
  six ring cannons, two heavy forward guns and a drone escort, at 9,000 health and double size.
  Every one of its numbers lives in the tank def rather than in an override applied after
  `recompute()`, because `recompute()` runs again on the next kill and would put them all back
  (this is bug 27 in the list below, learned once). The bots are told about it explicitly: the
  Juggernaut registers itself as `game.bountyTarget`, which outbids everything else in their
  target scoring, so they gang up on it instead of farming.
- **Prop Hunt** works because the renderer draws a tank from `sides` / `size` / `fill` / `stroke`,
  all writable at runtime — so a hider genuinely *is* a Square as far as the draw path is
  concerned, name plate and barrels suppressed. Hiders keep full movement speed; the tell is
  behaviour, not stillness. A seeker that shoots a real polygon pays 40 health for it.
- **Singularity** opens as a 40-unit speck with almost no pull and grows on a cubic ramp for
  twelve minutes until its radius covers the whole board. The accretion disc, lensing ring and
  infalling debris are all drawn from the live pull value, so the picture is the physics.
- **Chaos Rotation** draws one of fifteen modifiers every ninety seconds from a shuffled deck.
  It is also the argument against ever shipping thirty-eight separate online arenas: one
  well-populated FFA plus a modifier table beats eight empty lobbies.

### Adding one

A mode is a `GAMEMODES` row plus, if it needs one, a `MODE_LOGIC` entry. Two shapes:

```js
// a rule mode — no logic at all
labMode('icerink', { name: 'Ice Rink', family: 'Rules', rules: { friction: 0.02 }, blurb: '...', how: [...] });

// an objective mode
labMode('koth', { name: 'King of the Hill', teams: ['blue','red'], logic: {
  init(g) {...}, tick(g) {...}, reset(g) { labReset(g, 'koth'); }, botGoal(g, t) {...}
}, blurb: '...', how: [...] });
```

`Game.rule(key, default)` is the single lookup for every mode that is a changed constant rather
than a changed objective — `friction`, `dmgMult`, `regen`, `lifesteal`, `shapeXp`, `killShare`,
`spawnLevel`, `reloadMult`, `shapes`, `bots`, `fov`. `ruleOverride` is a live layer on top of it,
which is how Chaos Rotation switches a modifier on and off mid-round without touching the table.

Two rules that are not optional:

- **Every objective mode ships a `botGoal`.** Without one it plays fine online and looks broken
  offline, with the bots walking past the payload for ten minutes.
- **Never open the cheat gate to get an effect.** Setting `g.cheatsOn` to enable a mechanic hands
  `/god` and `/nuke` to everyone in the arena. That has already happened once here (bug 11).

Regenerate the website's mode data after adding one:

```bash
node -e "const fs=require('fs'),vm=require('vm');const s=vm.createContext({console,Math,JSON,Map,Set,Infinity,NaN});for(const f of ['js/tankdefs.js','js/data.js','js/tankdefs-extra.js','js/protocol.js','js/engine.js','js/modes.js','js/modes-extra.js'])vm.runInContext(fs.readFileSync(f,'utf8'),s,{filename:f});const o=Object.keys(s.LAB_MODES).map(k=>{const m=s.LAB_MODES[k],g=s.GAMEMODES[k];return{key:k,name:m.name,family:m.family,tag:m.tag,blurb:m.blurb,how:m.how,teams:g.teams?g.teams.length:0,size:g.size,arena:g.maze?'maze':'open'}});fs.writeFileSync('docs/modes.json',JSON.stringify(o,null,1));fs.writeFileSync('docs/modes.js','window.__MODES__ = window.__MODES__ || '+JSON.stringify(o)+';\n')"
```

## What's here

| File | |
|---|---|
| `js/tankdefs.js` | The tank table, generated from `data/tankdefs.json`. Never hand-edit. |
| `js/tankdefs-extra.js` | Seven tanks not in that dump; patches the table at load |
| `js/data.js` | Constants, palette, XP curve, shapes, addons, bosses, game modes |
| `js/engine.js` | 25 Hz simulation: entities, physics, damage, barrels, projectiles, AI, bots |
| `js/modes.js` | The six objective modes + possession (H) |
| `js/modes-extra.js` | The Mode Lab's 38 arenas — rules, logic, and the Juggernaut hull |
| `js/modefx.js` | Per-mode screen effects and the animated menu thumbnails |
| `js/modelab.js` | The Mode Lab button and its menu, markup and styles included |
| `js/protocol.js` | Binary wire format, shared by client and server |
| `js/net.js` | Client-side world mirror, snapshot interpolation, own-tank prediction |
| `js/render.js` | Canvas 2D drawing + HUD |
| `js/commands.js` | The chat command table, shared by client and server |
| `js/chat.js` | Chat overlay (DOM) + the client half of the command dispatch |
| `js/main.js` | Input, fixed-timestep loop, menu |
| `server.js` | Authoritative game server (also serves the static files) |
| `test.mjs` | 100 simulation tests |
| `test-modes.mjs` | 681 Mode Lab tests — registration, resets, rules, effects |
| `docs/index.html` | The Mode Lab website; draws its tiles with the game's own `modefx.js` |
| `test-net.mjs` | 50 network tests against a live server |
| `test-bots.mjs` | 75 bot-AI tests |
| `test-wheel.mjs` | class-tree wheel geometry |

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
  `/timewarp`, `/view`, … 50 of them) are gated on `ctx.sandbox`: always allowed
  offline, online only inside a Sandbox arena. The gate is checked by whoever owns the world, so a client cannot cheat
  its way past it. `/help` lists everything, `/cheats` lists just those.

## Objective modes

These are diep.io's own six. The 38 in the Mode Lab use the same machinery, with three hooks
added for them: `onSpawn` (dress a fresh tank), `filterUpgrades` (narrow the upgrade offer) and
`botGoal` (tell the bots what the objective is).

Each lives in `js/modes.js` as an `init` / `tick` / `onTankDeath` / `reset` entry that the
engine dispatches on by name. Winning a round posts a banner, then resets the objectives and
respawns everyone rather than tearing the arena down.

| Mode | Teams | XP | How you win |
|---|---|---|---|
| **Survival** | — | ×3 | Be the last tank standing |
| **Domination** | 2 | ×2 | Hold all four Dominators |
| **Tag** | 4 | ×3 | Every living player ends up on your team |
| **Mothership** | 2 | ×3 | Destroy the enemy Mothership |
| **Breakout** | 2 | ×2 | Claim the whole 8×8 board |
| **Capture the Flag** | 2 | ×1 | Capture all 10 enemy flags |

- **Survival** — one life each. A 10 s countdown, then the respawn button goes away and the
  field closes in on whoever is left: the arena is `⌊25·√players⌋·100` du wide and the shape
  quota `⌊12.5·⌈(width/2500)²⌉` follows it down, so the last two fight in a 3,500-unit box.
  A new round hands everyone a fresh level 1.
- **Domination** — four 6,000 HP Dominators (Destroyer/Gunner/Trapper flavours, taken from the
  real tank table) sit bolted down at the centre. Kill a neutral one to capture it; kill an
  enemy-held one and it reverts to neutral first, so taking ground costs two fights. They never
  actually die — they revive in place under the new owner, dropping their projectiles and
  ejecting any pilot.
- **Tag** — dying to a player moves you onto *their* team; dying to a shape does not. The arena
  slowly shrinks, and invisibility is capped at 25 % opacity so nobody can stall the round out.
- **Mothership** — one 16-sided, 16-barrelled, 7,000 HP Mothership per team, flying itself
  until a pilot takes over. The wheel passes to the team's highest scorer every 5 minutes.
  With no bases in this mode, each side spawns around its own Mothership.
- **Breakout** — you can only claim ground that touches ground you already hold, so the front
  advances rather than teleporting. Camp your own tile for 30 s and it flashes, then collapses
  and kills you.
- **Capture the Flag** — a barrier splits the map for the first 5 minutes. Touch an enemy flag
  to carry it, reach your base to score; dying drops it straight back home.

**Press H** to take control of a Dominator or Mothership your team holds, and again to step
out. Piloting *parks* your own tank rather than destroying it — you keep your score and get it
back where you left off. Parked tanks have no collider and are never sent to other clients.

The scoreboard adapts: objective modes with a per-team tally replace the player list with it
(Tag shows player counts, Breakout territory %, Mothership hull %, CTF captures) — built once in
the engine, so offline and online show the same rows. Survival and Domination keep the player
list; neither shows mode entities on it.

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

**Your own tank is predicted.** Everything else on screen is the server's word,
interpolated between the last two snapshots. Waiting a full round trip to watch your
own tank answer a key is the one thing that made this feel unlike the real game, so
the client runs the same three lines of `Tank` movement locally as well: every input
packet carries a sequence number, the server echoes back the last one it applied, and
each snapshot rewinds your tank to the position that input produced and replays the
inputs the server has not seen yet. A disagreement — a wall, a knockback, a move the
server refused — is settled by the replay inside one snapshot rather than by the
client insisting. Prediction switches itself off whenever your keys are not what moves
the thing the camera is on: piloting a Dominator, or watching someone with `/view`.
The echoed sequence number also gives a real round-trip figure, which is what `/ping`
now reports.

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
- **The Mode Lab** — 38 extra gamemodes behind a button on the main menu, in eight families,
  each with an animated tile and a written explanation. Twenty-eight of them define their own
  visuals — fog banks, a growing black hole, a hazard ring, a traffic light, a crown, a fuse —
  and every one of them ships a bot goal so the offline arena plays the objective too. See above.
- **All 11 of diep's game modes** — FFA, 2 Teams, 4 Teams, Maze (40×40 cells of 635 du, walls that eat
  what is fired at them), Sandbox (+ cheats), plus the six objective modes below. Team bases with drone spawners, enemy-projectile
  dissolve, and rammer ejection.
- **UI** — scoreboard, score/level bars, stat panel with queueing, upgrade cards, minimap,
  leader arrow, notifications, class-tree overlay, death screen with killer attribution.
- **Chat** — top-left overlay, arena-wide online, 76 slash commands including a cheat set
  that only unlocks offline or in a Sandbox arena. See above.
- **28 bots** with real builds and class choices, so the leaderboard is alive. *Play
  Offline* opens a difficulty picker first — Easy through Extreme, or Custom, which
  exposes the six skill dials (aim, reflexes, dodging, footwork, aggression, game sense)
  and the bot count. The setting is also reachable from the menu's *change* link and from
  `/difficulty <name>` in chat. Bots lead their shots, strafe, dodge incoming fire, pick
  targets on threat rather than proximity, retreat when hurt, and space themselves by
  their own weapon's reach — how much of that they do is what the difficulty sets.
- **31 builds**, taken from the community build tables rather than invented, covering the
  three archetypes players actually run: glass cannons, rammers and bullet smashers, plus
  the drone, trap and sniper variants. Each bot rolls a *taste* at spawn — one to three
  builds it likes — and runs whichever fits the class it ends up in, so a bot that likes
  drones plays an Overlord one life and a Battleship the next. It also rolls how far it
  strays from the book: most copy a build exactly, some trade a couple of points, a few
  make their own up. Classes are chosen to serve the build and to reach the branch it
  lives on, including waiting out the level-15 upgrade when what it wants opens at 30.

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

A parity-and-hardening pass over the finished game found six more, and closed five
gaps that had never been built at all:

10. **Necromancer could mint drones out of nothing.** Its two barrels are declared
    `droneCount: 0`, which fell straight past the child cap in `Barrel.tick` — so
    holding fire spawned permanent, controllable necro drones with no cap and no
    Squares consumed. The class exists to reanimate Squares and nothing else, so
    those barrels now never fire; `tryClaim` is the only thing that makes a drone,
    and it has always respected the `11 + reloadStat` cap.
11. **`/cheats on` opened a public arena.** The gate was written as Sandbox-only
    online, but the switch itself was not gated: any player in a live FFA match
    could hand `/god`, `/nuke` and forty-odd others to everyone in it. Online it
    now refuses; offline the arena is yours and the switch stays.
12. **A full server bricked the Play button.** The join was answered with a notice
    and then nothing — socket open, no arena, no tank, and no close event to send
    the client back to the menu. It now says why and hangs up, and the client
    reports the reason instead of "Disconnected from server".
13. **A stalled client grew the server's memory without limit.** Snapshots were
    queued onto the socket at 25 a second whether or not it was draining. A
    snapshot is whole-world state, so one is now skipped rather than queued when
    the send buffer is more than a megabyte behind — leaving `client.seen`
    untouched with it, so the next snapshot still carries the creates that one
    would have.
14. **Notification lifetimes were lost in transit.** `notify(text, ticks)` carries
    its own duration; the wire dropped it and the client guessed 100 ticks at
    everything, so a 40-tick toggle and a 7.5-second capture banner sat on screen
    for the same four seconds. The duration now ships with the text.
15. **The upgrade panel could not be re-opened.** Collapsing it hid the cards until
    a *new* tier unlocked, so collapsing at level 15 read as a lost upgrade. The
    collapse now leaves its tab behind.

Three things that were simply wrong on screen:

16. **The hit flash was white.** Every entity blended toward `#FFFFFF` on damage,
    which washed a Square out to the same colour as a shiny one. It is red.
17. **Ubuntu was never actually loaded.** Every font string in the DOM and on the
    canvas asked for it and silently fell back to Verdana. One `<link>`; offline
    it falls back exactly as before, so nothing depends on the fetch.
18. **The stat-bar colours had drifted.** `DIEP_CONSTANTS.md` lists all eight off
    the real client and `data.js` carried desaturated near-misses of them — right
    order, wrong hues. Replaced with the documented values.

And two the bots were missing:

19. **Bots fired through maze walls.** Nothing in the target scan asked whether the
    shot could reach — the bullet died on the wall, so it was pure noise plus a
    muzzle flash telling the other side of the corridor where they were. `botLOS`
    clips the segment against the wall boxes, and it runs once per bot per tick
    against the target already chosen rather than once per candidate. Outside Maze
    and the CTF barrier `walls` is empty and it costs nothing.
20. **Your own tank waited a round trip.** See *Own tank is predicted*, above.

Then a pass over the objective modes themselves, which turned up seven that made
three of them unplayable rather than merely wrong:

21. **Tag could not be won.** Dying to a player sets `nextTeam`, and only the human's
    respawn ever read it — a bot's respawn queue carried a level and nothing else, so
    every bot was re-balanced onto the emptiest team and each tag was undone within
    seconds. The queue now carries the team as well, and the mode hook runs *before*
    the queue entry is written rather than after it. A new round drops the queue, so
    the next one starts spread over four teams instead of one.
22. **Breakout deleted its own polygons.** A claimed tile is meant to dissolve enemy
    fire crossing it; the test for "is this a projectile" was `e.owner !== undefined`,
    which is true of every entity there is. Every shape standing on claimed ground died
    on contact, respawned, and died again — the board was bare and the shape spawner ran
    flat out forever.
23. **Maze walls bounced bullets.** They were supposed to eat them (§9), and the bots'
    line-of-sight code was written on the assumption that they did (fix 19). The kill
    branch was gated on the wall's team differing from the shooter's, and walls are
    neutral, so it never once fired.
24. **CTF flags stood inside the base defending them.** A team base kills an enemy tank
    in about half a second, so no flag could ever be stolen and no round could be won.
    They now stand 400 du clear of the base edge.
25. **A mode reset leaked its walls.** Walls live in `entities` *and* `g.walls`; the
    sweep only cleared the first, so every CTF round left another dead barrier blocking
    shape spawns and bot sightlines at x=0 for the rest of the arena's life.
26. **Mothership spawned you in the enemy's half.** The mode has no bases, and the
    no-base path is a roll anywhere in the outer ring — so half of each team arrived
    on the wrong side of the map. Each side now spawns around its own Mothership.
27. **Numbers that had drifted from `DIEP_CONSTANTS.md`:** the Mothership's HP (3,000
    against a documented 7,000) and its knockback fields, which were being overwritten
    with hand-picked values after `recompute()` had already read the correct ones off
    the tank table; the Dominator's damage multiplier (tank-body 6 rather than
    boss-tier 4); the Maze arena (22,300 against 40×635 = 25,400); and the 2-Teams base
    width. Offline, the scoreboard also listed Dominators and Motherships as players on
    nought points, and ignored the per-team tally the online one has always shown.

## Attribution

`data/tankdefs.json` is the balance table from
[DiepCustom](https://github.com/ABCxFF/diepcustom), which is **AGPL-3.0**. It is fetched as a
data asset rather than vendored into source. If you distribute this or run it as a network
service, the AGPL's terms apply to that data file — check them before publishing.

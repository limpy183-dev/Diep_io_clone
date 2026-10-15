# Tank Arena

**A diep.io replica — and then a lot more on top of it.**

The replica half is built to the attached reverse-engineering spec and does not take
liberties: exact tick rate, exact formulas, the real class tree, the real balance data,
all five bosses, all eleven of diep's own game modes, and authoritative multiplayer with
client-side prediction. If you have played diep.io, this is that.

The other half is everything diep.io does not have. The headline is the **[Mode Lab](docs/index.html)**
— 39 extra gamemodes reached from a button on the main menu, from Gun Game and Prop Hunt to a
black hole that starts as a speck and ends by swallowing the arena. Several bring their own
visuals: real fog, a nightfall that actually dims your vision, an accretion disc, an ice sheet
with cracks and skate marks, a twelve-sided custom Juggernaut, and a hundred and forty more custom
hulls in an eight-ring tree of their own that runs to level 200. On top of that there are 76 chat commands including a 50-strong cheat set,
bot difficulty down to six individual skill dials, 31 real community builds the bots draft from,
and a class-tree wheel.

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

Run the tests — 1,048 of them:

```bash
npm test
```

`npm run test:modes` runs just the Mode Lab suite, which is the fast one.

## The Mode Lab

Press **MODE LAB** on the main menu — the button under the bot-difficulty line. It opens a wall
of 39 tiles, each one live-rendered rather than a screenshot. Click a tile and it expands into a
full-screen view — the composition scales with the box rather than being spread across it — with
a write-up of the mode beside it, a bot-difficulty picker, and Play Offline / Play Online.

There is a browsable version of the same wall at **[docs/index.html](docs/index.html)**, which
loads the game's own `js/modefx.js` so the tiles on the site are drawn by exactly the same code
as the tiles in the game. To publish it, turn on GitHub Pages with the source set to
*Deploy from a branch → main → /docs*; it then serves at
`https://<user>.github.io/<repo>/`.

| Family | Modes |
|---|---|
| **Rules** — one constant, whole new game | Chaos Rotation, Score Attack, Instagib, Vampire, Ice Rink, Blood Money, Locust |
| **The Tree** — the 56 classes are the content | Gun Game, Draft Roulette, Mirror Match, Randomizer |
| **Asymmetry** | Juggernaut, Juggernaut Royale, Juggernaut Armageddon, Last Juggernaut, Infection, Boss Rush, Siege, Closer Gauntlet, Boss Royale |
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
- **Juggernaut Royale** is the other side of that coin: *everybody* is a juggernaut, and
  juggernauts grow. **A hundred and forty custom hulls on eleven branches, nine tiers deep, to
  level 200**, wired into `TANK_DEFS` with real `upgrades` arrays and real level requirements — so
  the upgrade cards, the class-tree overlay and the server-side gate in `upgradeTo` are the game's
  own. A juggernaut tree is just another tree.

  The level ceiling is a mode rule (`maxLevel`), not a fork: 45 everywhere else, 200 in here, with
  the tiers gated at 1 / 12 / 24 / 36 / 52 / 70 / 100 / 140 / 200. Four more rules pay for it.
  `shapeXp` and `killBounty` go up with the ceiling; `lvlScale` and `lvlSlow` soften diep's own
  per-level growth and slowdown curves, which run to 9x size and a twentieth of the speed if you
  take them to 200 unchanged. `data.js` also stops the score curve's 6% compounding at level 100 —
  left alone, level 199 alone costs four hundred times level 100 and the ladder stops being a
  climb. Flattened, the whole 1..200 run costs 6.7x the 1..100 one.

  **Every card is a group.** No node in the tree hands you a single hull — the worst case is a
  choice of two and most of it offers three. The one exception is the crown at level 200, which is
  not a choice, because by then there is exactly one thing left to become.

  | Branch | What it is | Signature | Ends at |
  |---|---|---|---|
  | **Warden** | Fires no bullets at any point. Hooded trap launchers, turrets on a plinth. Terrain. | `BARRICADE` — ten traps thrown down in a ring around it | **Citadel** — 10 launchers, 5 turrets, 6,200 hp, under half a tank's speed |
  | **Reaper** | Barely fires either. Drones, then more drones. | `SWARM` — every drone it owns hurled at what it is looking at | **Broodmother** — 32 drones out of 4 hangars |
  | **Bulwark** | **No barrels whatsoever.** Armour and contact damage. | `SLAM` — everything inside 2.7 radii thrown off and hurt | **Leviathan** — 20 sides, 8,600 hp, 54 contact damage |
  | **Lodestone** | A gravity well bolted to the hull. Bullets bend into it and die on it. | `PULL` — tanks and fire alike dragged in | **Event Horizon** — an inner ring that simply deletes what crosses it |
  | **Cinder** | Heat. Contact ignites, ground stays on fire, damage is banked. | `OVERLOAD` — the bank spent at once; at full heat it survives on 1 hp | **Meltdown** — eight ember barrels and one detonation a life |
  | **Rime** | Cold. A field that halves anything in it. | `FREEZE` — the ring stopped dead, movement and guns both | **Permafrost** — `SLICK`, a sheet of ice with no friction on it |
  | **Leech** | Blood. Damage feeds it; the dead work for it. | `REAP` — a mouthful torn out of everything close | **Ossuary** — husks orbiting as armour, eaten for an instant heal |
  | **Effigy** | Deception. Decoys the renderer draws as real tanks, and bots target as real tanks. | `DECOY` / `BLINK` — copies of you, and six hundred units away from them | **Hydra** — dies into three half-size Hydras |
  | **Metronome** | Time. Four seconds armoured, four seconds fast, forever. | `REWIND` — position and health, three seconds back | **Chronoform** — a field where other people's clocks run slow |
  | **Arsenal** | Siege. It roots and stops being a tank. | `DEPLOY` / `MORTAR` — bolted down, and a shell where the cursor is | **Fortress** — six turrets that keep firing fifteen seconds after it leaves |
  | **Parasite** | Theft. Score, drones, and barrels off the hull it killed. | `INFEST` / `HIJACK` — latched on, or your swarm is theirs | **Usurper** — wears a barrel from everything it has killed |

  Every branch above ends in **at least two** hulls, so level 36 is a fork. Six of the second
  endings exist for that reason — the **Labyrinth** (a Warden that never stops moving, laying a
  corridor behind it), **Hivewright** (minions, drones and orbiters at once), **Conflagration**
  (spends its heat continuously instead of banking it), **Aeon** (exactly as strong as whoever is
  winning is winning), **Ballista** (range where the Fortress has walls) and **Changeling**
  (tethered, latched and draining). Tier 3 also holds six **wilds**: **The Hollow** (bullets stop
  dead at the shell), **Tessellate** (health in four orbiting segments), **Kingmaker** (stronger
  every time anybody anywhere dies), **Nomad** (scales with distance from the middle), **Wrecking
  Ball** (a mass on a chain) and **Devourer** (physically grows on what its field swallows).

  Tier 4 is where the branches touch for the last time: sixteen **fusions**, each the marriage of
  two verbs, and every branch is half of two or three of them — Thermocline, Ashbrood,
  Worldbreaker, Voidforge, Necropolis, Wraithhive, Horologium, Aurora Lance, Plaguelord, Gorgon,
  Ironmaw, Caldera, Bastille, Nullpoint, Frostbrood and Cordyceps. They burn two branch colours at
  once.

  ### The dynasties — why the pick matters

  Up to level 52 the tree is a lattice, and a fusion having two parents is the point of a fusion.
  From 52 up it is not a lattice at all. The fusion you take seals you into one of eight
  **dynasties**, and the apex at 70, the omega at 100, the titan at 140 and the crown at 200 above
  it belong to that dynasty and to nothing else. No two dynasties share a hull, nothing outside a
  dynasty can reach into it, and both halves of that are asserted rather than remembered. The cards
  you are offered at level 70 are proof of what you took at 52.

  | Dynasty | Fusions that lead in | Apexes | Omegas | Titans | Crown at 200 |
  |---|---|---|---|---|---|
  | **Pyre** | Caldera, Ashbrood | Ragnarok, Pyroclast | Extinction, Solaris | Sunkiller, Cataclysm | **Solar Tyrant** |
  | **Glacier** | Thermocline, Frostbrood | Absolute Zero, Whiteout | Fimbulwinter, Glasswinter | Everwinter, Rimelord | **Absolute Winter** |
  | **Titan** | Worldbreaker, Ironmaw | Behemoth, Atlas | Apotheosis, Godhulk | Worldspine, Colossus Prime | **World Engine** |
  | **Ordnance** | Voidforge, Aurora Lance | Ordnance, Bombard | Annihilation, Siege Perilous | Siegebreaker, Ordinator | **Last Word** |
  | **Bastion** | Bastille, Necropolis | Sepulchre, Rampart | Sanctum, Necrarch | Aegis Eternal, Dread Keep | **Eternal Bastion** |
  | **Void** | Nullpoint, Wraithhive | Oblivion, Umbra | Singularity, Null Sovereign | Eventide, Abyssal | **Endless Night** |
  | **Chrono** | Horologium, Gorgon | Paradox, Epoch | Eternity, Zero Hour | Aeon Engine, Causality | **Final Hour** |
  | **Vermin** | Plaguelord, Cordyceps | Legion, Hollowbrood | Ouroboros, Hivegod | Swarm Sovereign, Carrion King | **The Devouring** |

  ### More than a bigger number

  To level 52 a hull is one ability on right-click and one passive. Above it that stops being
  enough, and the answer is not "a third verb".

  - **Autonomous buttons.** An apex carries one verb *on top of* its right-click one, an omega two,
    a titan two or three, a crown four — and they fire **themselves**, each on its own cooldown,
    each asking the same question the bot AI asks about the primary: is anybody in the right place,
    and am I hurt enough for this to be worth it. You still drive one button. The hull drives the
    rest, and that is the difference between a big tank and a boss fight with a pilot.
  - **Traits** — the things that are not verbs at all, and the answer to "the level-100 hulls only
    have one ability". `aegis` is a slab of armour in front of the health bar that regrows after
    five seconds untouched. `revive` refuses the first death of a life outright and detonates on
    the way back up. `bulwark` caps what any single hit is allowed to remove at 3% of the bar.
    `retinue` keeps a permanent escort of turrets flying with the hull. `reflect` turns bullets
    around inside the shell and hands them back with your name off them. `dread` makes everything
    near it reload slower and hit softer. `pierce` goes through armour; `vampire` heals a fifth of
    everything it deals; `tithe` takes score off everything it damages; `executioner` finishes
    anything under a tenth of its health that touches it. Plus `wake`, `growth`, `regalia`,
    `overclock`, `blinkstep`, `warcry` and `omniscient`. A crown carries **six at once**.
  - **Fifty-one ability verbs** across the roster. The late half of them do not do rings around the
    hull, because the things above the fusions are not really tanks any more: `METEOR` (nine shells
    walked across the cursor), `RUPTURE` (the ground opened in a line), `COLLAPSE` (the screen
    dragged to a point, then the point goes off), `STASIS` (everything visible held still),
    `JUDGEMENT` (a share of everybody's maximum health, no travel time, no line of sight), `ARC`
    (lightning walking tank to tank), `CITADEL` (a fort in one press), `UNMAKE` (every hostile shot
    on screen deleted), `WARPSTORM`, `TERRAFORM`, `CONSCRIPT`, `DOMINION`, `AVATAR`, `EPOCH` (the
    arena walked back three seconds), `ENTHRONE` and `APOCALYPSE`.
  - **A steeper dividend.** `JR_DIVIDEND` in `jrTickTank` is a per-tier row of [damage taken,
    reload multiplier, contact multiplier]: an apex takes 86% of what lands, an omega 70%, a titan
    50% and a crown **33%**, while its contact damage runs at 3x what the row says.

  Tier 8 at **level 200** is eight crowns, one per dynasty. **Solar Tyrant** fires `APOCALYPSE`,
  which sets the *visible arena* on fire, and its `tyrant` passive bleeds everybody else in the
  round while it leads. **World Engine** is 96,000 hp and 200 contact damage on thirty sides with
  no barrel anywhere on it. **Last Word** carries nineteen barrels, twelve turrets and eight
  escorts. **Endless Night** is three hundred units of invisible event horizon that sees everything
  and is seen by nothing.

  ### Skill points that keep going

  A stat pill is a 210px strip and there are eight of them, so it cannot get longer — but eight
  seven-pip bars hold 56 points and level 200 hands out 84. So the bar **compresses**: fill all
  seven pips and they collapse into a single lit block, leaving six to fill, which collapse into
  two, leaving five. Seven ranks — 7 + 6 + 5 + 4 + 3 + 2 + 1 = **28 points** — and then the row is
  solid, there is physically nowhere left to put a point, and the label reads `MAX`. 28 x 3 = 84 is
  exactly the level-200 budget, so a finished build at the cap is three stats taken all the way and
  nothing else. `statBar()` in `data.js` owns the arithmetic; the renderer only paints it, and a
  def whose stats cap at 7 draws exactly as it always did. Two mode rules, `statHealthPct` and
  `statBodyPct`, pay Max Health and Body Damage as a share of the hull instead of diep's flat
  +20/point, which is the difference between a point being worth something on a 900 hp Brute and on
  a 96,000 hp World Engine.

  Underneath it is one table. A hull is a row — silhouette, one `JR_GUNS` call, an ability verb, a
  list of autonomous verbs, a list of passives and a list of traits — and the ability dispatcher,
  the aura painter, the bot's range profile and the wheel all read it off the def. Four status
  effects (burn, chill, freeze, bleed) stack across branches because they are resolved in one
  place, and everything a hull does *at the moment something lands on it* is in one function,
  `jrTakeDamage`, chained onto the tank at spawn exactly the way `onKill` already was. Nothing in
  the engine was forked to do any of it: `Tank.tick` rewrites `damageReduction` every tick and
  `logic.tick` runs after it, so a mode override lands for exactly one tick and unwinds itself.

  **Bots read their own hull.** Each is handed one of the eleven branches on spawn and climbs it
  until the branches marry at tier 4, then follows whichever dynasty its fusion put it in — so all
  eleven get driven instead of twenty bots converging on whatever scores best — and the
  mode's `botDrive` hook then overrides the generic AI with the job the row implies: bodies charge
  to zero range, trap hulls close to 500, snipers back off anything inside 900, siege hulls plant
  themselves. The button has a condition per verb rather than a cooldown mash.

  Press **Y** in there and the wheel shows *the juggernauts* — a mode can name its own
  `treeRoot`, so the class-tree overlay grows from the Brute rather than from the Basic tank you
  cannot reach a single node of from inside the mode. It also sets `treeUnique`, because past tier
  3 every hull has two or three parents: drawn as a plain sunburst that is thousands of slivers,
  and drawn once per hull it is 139 readable sectors over eight rings. The hulls are built into `TANK_DEFS` at
  load rather than in `init()`, because the client draws them and online the client never runs a
  mode's `init()` at all: a remote player in a Bastion has to have a Bastion to draw.

  The branches never converge, because one shared endgame is exactly what "all the paths are the
  same" feels like. The silhouettes carry it too: trap hulls wear the flared `trapLauncher` hood,
  drone hulls wear wide outward trapezoids, and the melee line wears the spiked guard shells and
  literally nothing else — its bullet stats are capped at zero so the stat panel says so as
  plainly as the shape does. The field runs at 2,600 polygons in an 18,000-unit arena, about five
  times normal density, because climbing costs and farming is the half of it that isn't fighting.
- **Last Juggernaut** is the two of them crossed, and it is almost entirely made of parts that
  already existed. You climb the Royale tree — all 140 hulls, all nine tiers, the cap at 200 — and
  you are the only tank in the arena on it; everybody else is an ordinary level-45 tank on one
  team, handed the Juggernaut mode's own bot handling with the mark pointed at *whoever is a
  person* rather than at whoever is wearing the crown. The mode's own code is three things: the
  player half of the Royale's tick (the per-tank pass, the autonomous verbs, the button), the
  Juggernaut's ring respawn and collar range, and a memo. **The crown never changes hands.** There
  is no next juggernaut to promote, so `onTankDeath` stores your hull id, score and stat spread and
  `onSpawn` puts them straight back: you come back on the same hull at the same level and the mob
  starts the job over. `spawnLevel: 45` is what makes that survivable — it is three cards deep in
  the tree plus 33 stat points, and spawn protection holds until you shoot or drive, so you go in
  as a tier-3 hull rather than as a 900 hp Brute. `killBounty` is the one number neither parent
  mode had: in the Royale a kill pays more every tier because the thing you killed grew too, and
  here the hunters are level 45 all round, so the bounty carries the top half of the climb alone.
- **Juggernaut Armageddon** is the Royale with the ceiling taken off. All 140 hulls, all nine
  tiers and the crowns at 200 are exactly the Royale's — and then **five more tiers, forty-three
  more hulls and a level cap of 500**. The crowns stay leaves in `TANK_DEFS`, because the Royale
  ends at 200 and has to keep ending there; Armageddon hangs its tiers off them with two hooks the
  engine already had — `filterUpgrades` adds the cards (so the server gate in `upgradeTo` is still
  the gate) and a new `treeGraft` mode field adds the same edges to the Y wheel, which grows to
  thirteen rings. The hulls live at ids 256-298, which is why a tank's class id and level now ride
  the wire as a `u16` rather than a byte.

  | Tier | Level | Hulls | Fires itself | Traits | Dividend (taken / reload / ram / guns) |
  |---|---|---|---|---|---|
  | crown (Royale) | 200 | 8 | 4 | 6 | 33% / 0.44 / 3x / — |
  | **Ascendant** | 240 | 16, two per dynasty | 5 | 7 | 24% / 0.40 / 4x / 1.5x |
  | **Archon** | 300 | 16 | 6 | 8 | 17% / 0.37 / 5.2x / 2.1x |
  | **Primordial** | 370 | 8 | 7 | 9 | 12% / 0.34 / 6.8x / 2.9x |
  | **Eschaton** | 440 | 2 — First Light, Last Dark | 8 | 10 | 8% / 0.31 / 8.8x / 4x |
  | **Armageddon** | 500 | 1 | 10 | 12 | 5% / 0.28 / 12x / 5.5x |

  Every tier beats the one under it in every column at once, and each step is a bigger step than
  the last — the test suite asserts both. **The dynasties marry again** at 370: sealed apart at 52,
  they meet on a ring (Pyre, Titan, Ordnance, Bastion, Vermin, Void, Chrono, Glacier), so each
  Primordial is the union of two neighbours and each Archon chooses which neighbour it becomes.
  **Abilities stack**: the `jrStack` rule lets every loaded autonomous verb fire on the same tick
  instead of one a tick, and `jrHaste` shortens every cooldown by a quarter. Eleven new verbs —
  `OVERDRIVE` (every other button at once), `SUPERNOVA` (three widening shockwaves), `BLACK HOLE`
  (a free-standing well under the cursor), `SKYFALL`, `TIME STOP` (tanks *and* bullets held for
  four seconds), `RAPTURE`, `GENESIS`, `TEMPEST`, `FISSURE`, `GODRAY` and `THE BIG BANG` — four new
  passives (`corona`, `maelstrom`, `stormcall`, `quicken`) and four new traits (`immortal` refuses
  three deaths a life and goes supernova each time, `echo` lands every verb twice, `thunder`,
  `nullify`). Past the crowns the dividend grows the guns too, through the tank's own
  `bulletDamage` multiplier. The effects escalate tier by tier — sunbursts, wings and orbiting
  runes, lightning, binary-star auras, a black sun with a red heartbeat — with screen flashes, a
  grey-out while the clock is stopped, and a world-only screen shake that switches itself off under
  `prefers-reduced-motion`. The soft light — glows, god-rays, the darkening — is drawn into a
  quarter-resolution buffer and laid over the arena once a frame, which took the Armageddon's
  aura from 33 ms a frame to under 6. And whenever a hull past the crowns is near the screen the
  floor dusks toward a bruised purple, because additive light on diep's light grey is white in two
  layers. Three engine rules came out of it, all mode-gated: `shotCap` caps projectile radius
  (the broadphase is a uniform 128-unit grid, and an uncapped level-400 hellbore landed in seven
  hundred cells on its own), and `trapCap` / `bulletCap` cap how many traps and rounds one tank
  may have out at once (uncapped, a Bastion-line hull held 2,700 traps and the arena ran at a
  tenth of real time).
- **Chaos Rotation** draws one of fifteen modifiers every ninety seconds from a Fisher-Yates
  shuffle, drawn without replacement. Each modifier is written as an arena part and a *per-tank*
  part, and the per-tank part re-applies on every spawn while it is live — otherwise a modifier
  quietly stops applying to half the arena within thirty seconds. It is also the argument against
  ever shipping thirty-nine separate online arenas: one well-populated FFA plus a modifier table
  beats eight empty lobbies.

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

### Teaching the bots

There are two hooks, and the difference matters.

`botGoal(g, t)` returns a **hint**: a point or an entity the ordinary AI weighs against spacing,
strafing, dodging and whatever polygon is underfoot. Good enough for "go stand on the hill".

`botDrive(g, t)` runs immediately after `tickBot` and **overrides the movement keys outright**.
Some rules are not negotiable and a hint loses. Red Light, Green Light proved it: with a goal
that said "stop", bots died 921 times in sixty seconds, because at 25 Hz a tank at terminal
speed needs twenty ticks to reverse and the AI was still weighing its options. Driving them —
`botHalt`, `botDriveTo` — took it to 121, and somebody wins the race. Grand Prix, Prop Hunt and
Hide and Seek use it for the same reason: racing a line, holding still like furniture, and
staying faded are things a bot has to *do*, not consider.

Four rules that are not optional:

- **Every objective mode teaches its bots**, with a goal or a drive. Without one it plays fine
  online and looks broken offline, with the bots walking past the payload for ten minutes.
- **Never open the cheat gate to get an effect.** Setting `g.cheatsOn` to enable a mechanic hands
  `/god` and `/nuke` to everyone in the arena. That has already happened once here (bug 11).
- **`fieldFactor` is a zoom-OUT divisor: lower sees further.** A plain Tank is 1.0, Ranger is
  0.7. The Juggernaut shipped at 1.12, which meant the biggest hull in the game was looking
  through a *smaller* window than everyone hunting it. It is 0.82 now.
- **Put every derived number in the tank def, never in an override after `recompute()`.**
  `recompute()` runs again on the next score change and rebuilds `maxHealth`, `damagePerTick`,
  `absorb`, `movementSpeed` and `reloadTime` from the def. A Juggernaut buffed after the fact was
  back to 1,628 health on its first kill; a zombie buffed after the fact was an ordinary tank
  again the first time it touched a polygon. Where a value genuinely cannot live in the def
  (`push` is pinned at 8 by `recompute`), re-apply it every tick and say so in a comment.

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
| `js/modes-extra.js` | The Mode Lab's 41 arenas — rules, logic, the Juggernaut, the 140 Royale hulls and Armageddon's 43 |
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
| `test-modes.mjs` | 806 Mode Lab tests — registration, resets, rules, bots, effects |
| `docs/index.html` | The Mode Lab website; draws its tiles with the game's own `modefx.js` |
| `js/modelab.js` | (above) also carries the difficulty picker and the FLIP expand |
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

These are diep.io's own six. The 39 in the Mode Lab use the same machinery, with four hooks
added for them: `onSpawn` (dress a fresh tank), `filterUpgrades` (narrow the upgrade offer),
`botGoal` (hint at the objective) and `botDrive` (take the wheel outright).

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
- **The Mode Lab** — 39 extra gamemodes behind a button on the main menu, in eight families,
  each with an animated tile, a written explanation and a difficulty picker. Thirty-three define
  their own visuals — fog banks, a growing black hole, a cracked ice sheet, a hazard ring, a
  traffic light, a crown, a fuse, starting lights — and every one teaches its bots the mode.
  See above.
- **A winner screen.** A round somebody won ends on a diep-styled podium — top three on plinths,
  score, level, kills and finishing class — not on your own death screen. `winRound()` snapshots
  it, so no mode can forget to build one, and it rides the map-state packet so it works online.
- **Off-screen indicators** for the one thing that matters in a mode: the Juggernaut, the King,
  the hill, the payload, the ball, the bomb carrier, the Alpha, the boss wave. A 22,300-unit
  arena hides an objective completely, and a mode you cannot find reads as a mode where nothing
  is happening.
- **All 11 of diep's game modes** — FFA, 2 Teams, 4 Teams, Maze (40×40 cells of 635 du, walls that eat
  what is fired at them), Sandbox (solo, small arena, cheats always on), plus the six objective modes below. Team bases with drone spawners, enemy-projectile
  dissolve, and rammer ejection.
- **UI** — scoreboard, score/level bars, stat panel with queueing, upgrade cards, minimap,
  leader arrow, notifications, class-tree overlay, death screen with killer attribution.
- **Chat** — top-left overlay, arena-wide online, 76 slash commands including a cheat set
  that only unlocks offline or in a Sandbox arena. See above.
- **28 bots** with real builds and class choices, so the leaderboard is alive. *Play
  Offline* opens a difficulty picker first (except in Sandbox, which is solo) — Easy through Extreme, or Custom, which
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

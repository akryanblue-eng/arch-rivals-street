# Vision

**Internal codename: "Arch Rivals: Street" — see [Naming and IP](#naming-and-ip) before using this name anywhere public.**

This document holds the durable product direction. Implementation details, tuning
values, and sprint plans do not belong here — they live in code, PRs, and issues.
If a decision below changes, change it here first.

## Product direction

A **stylized 3D arcade basketball brawler**: chunky cartoon proportions, bright
cel-shaded materials, exaggerated hit reactions, dramatic dunk cameras, fast 2v2
matches, cosmetic-heavy customization, short mobile-friendly sessions.

Not a basketball simulation. Cartoon exaggeration is a deliberate choice: it keeps
the shoving/stealing comedic rather than harsh, keeps animation costs down, and
gives the game permission to be ridiculous.

## Controls

**Virtual joystick + contextual action buttons.** The joystick owns space and
positioning; buttons own verbs (shoot/pass, shove/steal, special when earned).

**Swipe gestures are modifiers, never sole triggers.** Every gesture decorates an
action already in progress:

- swipe up on shoot → dunk/layup
- swipe toward teammate → directional pass
- swipe during defense → dodge or body check

Directional passing is the highest-priority gesture to prototype: passing under
pressure is where 2v2 games live or die, and it is the hardest of the three to
make feel reliable.

## Mode order

**AI-driven arcade/story mode ships before any real-time multiplayer.** Real-time
PvP is a second game hiding inside the first (networking, lag compensation,
matchmaking, anti-cheat, server costs, disconnect handling) and is not started
until the combat loop is genuinely fun. The path:

1. Single-player 2v2 arcade matches
2. Boss teams with special hazards
3. Local / same-device testing
4. Asynchronous challenges and leaderboards
5. Real-time PvP — last, and only after step 1 has passed the fun gate

## First vertical slice

One polished match. One court, two teams, four stylized characters, first to 11.

Verbs in the slice: **movement, pass, shoot, shove, steal, one dunk.**

**The special-move meter is explicitly deferred.** It is the only candidate
feature that introduces a whole new system (meter economy, charge rates, balance
pressure) rather than a new verb. It is the first thing added *after* the base
loop passes the fun gate — not part of the slice.

### The three-minute fun gate

The slice exists to answer one question:

> Does controlling one character feel fun for three minutes?

Every scope decision defers to this. A "no" means iterate on the verbs, not add
features around them.

## The browser repo is the mechanics lab

The current browser prototype (this repository) is **not** the product and is
**not** migrated wholesale. It is the deterministic mechanics lab: it proves
possession, steals, scoring, AI behavior, and match flow cheaply and
reproducibly before those systems are re-implemented in Unity. It stays 2D,
stays dependency-free, and stays deterministic.

## Determinism is a portable asset — Unity port requirements

The lab's determinism discipline must survive the engine port. These are hard
requirements, decided now because they are far easier to preserve than to
retrofit:

- **Fixed timestep** for all gameplay simulation
- **Recorded input streams** as the canonical representation of a match
- **Deterministic gameplay math** — same inputs, same state, every run, every device
- **No gameplay-critical dependence on nondeterministic physics** — the physics
  engine may decorate presentation, never decide possession, steals, or scoring
- **Replay by re-simulation** — a replay (including dramatic replay cameras) is
  the recorded input stream played back through the sim, not captured video or
  saved state snapshots
- **Ghost / asynchronous matches as a future capability** — a shared challenge is
  a few kilobytes of inputs replayed locally, which is what makes roadmap step 4
  cheap and step 5 optional

## Naming and IP

**"Arch Rivals" is an internal codename only.** The original *Arch Rivals* was a
Bally Midway property, and Warner Bros. acquired Midway's game assets — the
name, characters, and recognizable franchise elements are legally risky for
commercial use unless licensed. The commercial identity will be an original name
developed separately. Do not use "Arch Rivals" in store listings, marketing
material, trailers, or anything public-facing.

## Not Yet

- Real-time PvP
- Matchmaking
- Seasons
- Loot boxes
- Stat-selling progression
- Large character roster
- Special-move economy
- Full Unity production migration

Items on this list are not banned — they are sequenced. Nothing moves off it
until the vertical slice passes the three-minute fun gate.

## Current near-term gate

**Human playtest of the merged balance fixes (PR #19) in the browser build.**
The playtest verdict decides the next branch: a clean result resumes the visual
readability queue (character silhouettes → ball-at-hand → camera); a lopsided
result makes defender-assignment AI the next target. No new direction work
starts ahead of that verdict.

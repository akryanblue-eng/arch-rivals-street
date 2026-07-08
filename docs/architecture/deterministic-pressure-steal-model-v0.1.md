# Deterministic Pressure-Based Steal Model v0.1

## Status

**Accepted implementation record.**

This document is a frozen checkpoint for the deterministic pressure-based steal model
introduced in PR #3. It is an architectural record, not a design proposal. The
implementation is live on `main`. Future iterations should treat this document as the
established baseline.

---

## Repository Lineage

```
3b8ebf6  Initial commit
    ↓
5fca99c  Web canvas prototype (PR #1)
    ↓
82ce6f4  Deterministic AI state machine (PR #2)
    ↓
e64e468  Scoring and win condition (PR #4)
    ↓
PR #3    Deterministic pressure-based steal model  ← this document
    ↓
         Future basketball intelligence systems
```

All commits listed above are reachable from `main` in this repository. No external
lineage is claimed.

---

## Problem Statement

### Previous Approach

The original steal mechanic was a per-frame random chance inside `trySteal`:

```javascript
function trySteal(defender, target) {
  if (dist < 18 && Math.random() < 0.08) {
    state.ball.owner = null;
    state.ball.vx = (Math.random() - 0.5) * 4;
    state.ball.vy = (Math.random() - 0.5) * 4;
  }
}
```

### Failure Modes

| Failure mode | Impact |
|---|---|
| Non-reproducible outcomes | Same game state could produce different steal results on replay |
| Untraceable decisions | No causal record of why a steal occurred |
| Weak AI behavior | Defenders felt lucky rather than skilled |
| Difficult balancing | Tuning `0.08` had no observable surface to reason about |
| Randomised ball scatter | Turnover direction was also random, compounding unpredictability |

The core problem was that the question the system answered was:

> "Did the random roll succeed?"

---

## New Model

The model answers a different question:

> "Did defensive pressure accumulate enough, based on observable game state, to force a
> turnover?"

### Data Flow

```
Defender position
    +
Carrier position
    +
Court geometry (hoop constants)
        ↓
calculateDefenderPressure()   ← pure function, per frame
        ↓
updateAccumulatedPressure()   ← writes to defender.pressure
        ↓
evaluateStealState()          ← threshold check → steal or continue
        ↓
Steal event / no event
```

Pressure resets whenever the defender leaves `GUARD_CARRIER` state for any reason.

---

## Implementation Contract

### Inputs

| Input | Source | Type |
|---|---|---|
| `defender.x`, `defender.y` | Current frame state | Position |
| `carrier.x`, `carrier.y` | Current frame state | Position |
| `carrier.team` | Derived from `state.ball.owner` | Enum |
| `HOOP_LEFT`, `HOOP_RIGHT` | Module-level constants | Position |
| `PRESSURE_RADIUS` | Named constant | Number |
| `BASE_PRESSURE` | Named constant | Number |
| `STEAL_THRESHOLD` | Named constant | Number |

There is no randomness, no timestamp, no velocity history, and no hidden mutable
state. Every input is explicit and inspectable.

### Constants

| Constant | Value | Role |
|---|---|---|
| `PRESSURE_RADIUS` | `60` | Pixel radius beyond which a defender builds no pressure |
| `BASE_PRESSURE` | `1` | Per-frame pressure multiplier |
| `STEAL_THRESHOLD` | `45` | Accumulated pressure required to force a turnover |
| `DEBUG_STEALS` | `false` | Flip to `true` to emit turnover audit logs |

These are **tuning parameters**, not structural decisions. The architectural contract
is stable regardless of their final values.

### Core Functions

**`calculateDefenderPressure(defender, carrier)`** — pure, no side effects

```
proximity = (PRESSURE_RADIUS - dist) / PRESSURE_RADIUS   // 0..1
laneAlignment = dot(hoop_direction, defender_direction) / normaliser  // -1..1
laneBonus = max(0, laneAlignment)                         // 0..1
return BASE_PRESSURE * proximity * (0.5 + 0.5 * laneBonus)
```

A defender generates maximum pressure when it is close to the carrier **and**
positioned between the carrier and the hoop the carrier is attacking. The two
contributions are independently observable:

- `proximity`: how close is the defender?
- `laneBonus`: is the defender blocking the passing lane to the hoop?

**`updateAccumulatedPressure(defender, carrier)`** — accumulates per frame

Adds the current frame's pressure to `defender.pressure`. This is the only write
to defender state in the steal model.

**`evaluateStealState(defender, carrier)`** — threshold check

If `defender.pressure >= STEAL_THRESHOLD`, a turnover is forced. The ball ejects
in the direction from carrier to defender (deterministic scatter, not random), and
`defender.pressure` resets to `0`.

### Pressure Reset Rule

```javascript
if (player.aiState !== AI_STATE.GUARD_CARRIER) {
  player.pressure = 0;
}
```

Pressure is scoped to an active guard. Any state transition out of `GUARD_CARRIER`
(ball turned over, teammate gained possession, ball went loose) clears it
immediately. A defender that leaves and re-enters `GUARD_CARRIER` starts from zero.

---

## Determinism Invariant

> Given the same `state.players[]` and `state.ball` snapshot, the steal model
> produces the same outcome on every execution.

Verification:

- No `Math.random()` anywhere in the steal path
- No `Date.now()` or `performance.now()`
- No untracked mutable state (`pressure` is explicit on each player object)
- No frame-order dependence (pressure accumulates monotonically within a possession
  and resets on possession change)
- No floating-point divergence risk (arithmetic only; no transcendentals)

---

## Explainability Model

Every steal has a causal footprint. A future debug trace can expose:

```
StealAttempt
 ├── defender:         B1
 ├── carrier:          A1
 ├── proximityPressure (per frame):   0.35
 ├── laneDenialBonus (per frame):     0.40
 ├── accumulatedPressure:            47.2
 └── threshold:                      45
```

The current implementation surfaces `pressure` and `threshold` in the `DEBUG_STEALS`
log. The per-frame `proximityPressure` and `laneBonus` are available by instrumenting
`calculateDefenderPressure` without changing its contract.

---

## Verification Evidence

| Check | Method | Result |
|---|---|---|
| Syntax | `node -c game.js` | Pass |
| No randomness | `grep -n "Math.random" game.js` | Zero matches |
| Pressure accumulation | Headless Chromium simulation | Pressure climbs per frame, crosses threshold, forces turnover |
| Threshold crossing | Headless simulation | Steal fires exactly when `pressure >= STEAL_THRESHOLD` |
| Pressure reset | Headless simulation | `defender.pressure` returns to `0` on state transition |
| No console errors | Headless run | Clean |
| Debug log | `DEBUG_STEALS = true` headless run | Log fires with expected `defender.id`, `carrier.id`, `pressure`, `threshold` values |

Manual gameplay tuning (human playtest, constant adjustment, balance validation) is
tracked separately and does not affect this architectural record.

---

## Known Limitations

**1. Tuning-dependent thresholds**

The constants `PRESSURE_RADIUS`, `BASE_PRESSURE`, and `STEAL_THRESHOLD` determine
how quickly pressure accumulates and how often steals occur. Their current values
are a starting point, not a final balance judgment.

Example at current values (60fps):

| Scenario | Frames to steal | Wall-clock time |
|---|---|---|
| 30 px away, full lane block | ~54 frames | ~0.9 s |
| 30 px away, perpendicular | ~90 frames | ~1.5 s |

**2. Lane-bonus angle sensitivity**

The lane-denial bonus is a dot product and is sensitive to exact angle. A defender
1° off the optimal blocking position generates significantly less bonus than one
perfectly positioned. This reflects real defensive depth but may need smoothing if
gameplay feedback identifies it as too punishing.

**3. Instant pressure reset**

Pressure clears immediately on state transition. A defender cannot "bank" pressure
across brief interruptions (e.g., ball going momentarily loose and returning to the
same carrier). This is intentional and correct for the current model but may evolve
if multi-possession defensive memory becomes a design goal.

**4. Single-defender model**

Pressure is per-defender and is not aggregated across a team. Two defenders
simultaneously guarding the same carrier each build independent pressure counters.
Combined team pressure as a first-class concept is a future extension.

---

## Future Expansion Hooks

The model is structured to support the following extensions without breaking the
current contract:

| Extension | Hook |
|---|---|
| Pressure replay traces | Instrument `calculateDefenderPressure` to emit per-frame decomposition |
| Difficulty scaling | Expose `PRESSURE_RADIUS`, `BASE_PRESSURE`, `STEAL_THRESHOLD` to a difficulty profile |
| Defender personality models | Vary constants per player object rather than module-wide |
| Lane-phase modelling | Add a phase-awareness term to `calculateDefenderPressure` (pre-dribble vs. mid-dribble) |
| Team defensive memory | Accumulate pressure across defenders for a shared possession counter |
| Player attribute integration | Weight `BASE_PRESSURE` by defender speed or agility attributes |

---

## Architectural Principle

> Determinism does not mean predictability. It means the outcome has a cause.

The model changed the question from *"did the random steal chance succeed?"* to
*"did defensive pressure accumulate enough, based on observable game state, to force
a turnover?"*

That is the architectural win. A defender that applies sustained proximity and
lane-denial pressure will eventually force the ball loose — reproducibly, auditably,
and for a reason that can be traced back to observable positions on the court.

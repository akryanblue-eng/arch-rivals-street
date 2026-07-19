# Deterministic Pressure-Based Steal Model v0.1

## Status

**Architecture record for a reviewed, unmerged implementation.**

This document is the checkpoint for the deterministic pressure-based steal model
implemented in PR #3 (branch `feature/deterministic-steal-pressure`, commit
`8acfa2f`). It is an architectural record, not a design proposal.

**The implementation is NOT yet live on `main`.** As of this revision, `main` still
runs the original random `trySteal` (`Math.random() < 0.08`), and none of the
functions or constants described below exist on `main`. Every implementation claim
in this document is verified against the PR #3 branch, not against `main`. This
record becomes the established baseline when PR #3 merges; until then, treat it as
the frozen contract that the merge must satisfy.

> Revision note (v0.1.1): the original version of this record incorrectly stated
> the implementation was live on `main`. This revision corrects the status, the
> lineage, the ball-ejection direction, and the frames-to-steal arithmetic, and
> scopes all verification evidence to the branch where it was actually gathered.

---

## Repository Lineage

```
3b8ebf6  Initial commit
    ↓
5fca99c  Web canvas prototype (PR #1)
    ↓
82ce6f4  Deterministic AI state machine (PR #2)
    ↓
e64e468  Scoring and win condition (PR #4)        ← current main
    ↓
[pending] PR #3  Deterministic pressure-based steal model  ← this document
    ↓
         Future basketball intelligence systems
```

The four commits above the `[pending]` marker are reachable from `main`. PR #3
(`feature/deterministic-steal-pressure`, commit `8acfa2f`) branched from `82ce6f4`
— *before* PR #4 merged — and is not reachable from `main`. No external lineage is
claimed.

### Integration status

PR #3 currently **conflicts with `main`** in `game.js` (verified with
`git merge-tree`): both PR #3 and PR #4 modified the `GUARD_STANDOFF` line. The
conflict is small but not mechanical — PR #4 lowered `GUARD_STANDOFF` from 20 to 12
specifically because the random `trySteal` required defenders inside its 18 px
window, while the pressure model builds pressure anywhere inside
`PRESSURE_RADIUS` (60 px), which removes that constraint. The rebase of PR #3 onto
current `main` must choose the standoff value deliberately against the pressure
model's geometry, not just take either side of the conflict.

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
proximity     = (PRESSURE_RADIUS - dist) / PRESSURE_RADIUS          // 0..1
laneAlignment = dot(carrier→hoop, defender→carrier) / (|carrier→hoop| · |defender→carrier|)  // -1..1
laneBonus     = max(0, laneAlignment)                                // 0..1
return BASE_PRESSURE * proximity * (0.5 + 0.5 * laneBonus)
```

The two contributions are independently observable:

- `proximity`: how close is the defender?
- `laneBonus`: where is the defender relative to the carrier's attacking direction?

**Intent vs. implementation (open discrepancy):** the design intent — stated in
PR #3's description — is that the bonus rewards a defender positioned *between* the
carrier and the hoop the carrier is attacking. The implemented dot product does the
opposite: `defender→carrier` points *away* from the hoop when the defender is
between carrier and hoop, making the alignment negative and the bonus `0`, while a
defender trailing the carrier (carrier between defender and hoop) scores the full
bonus. As implemented, chasing defenders build pressure up to 2× faster than
lane-blocking defenders. See Known Limitations #2 — this must be resolved during
the PR #3 rebase, either by flipping the sign or by revising the stated intent.

**`updateAccumulatedPressure(defender, carrier)`** — accumulates per frame

Adds the current frame's pressure to `defender.pressure`. This is the only place
pressure *increases*; the only other writes to `defender.pressure` are the resets
(on a successful steal, and on leaving `GUARD_CARRIER`).

**`evaluateStealState(defender, carrier)`** — threshold check

If `defender.pressure >= STEAL_THRESHOLD`, a turnover is forced. The ball ejects
along the defender→carrier line (velocity `(carrier − defender) / dist × 3`), i.e.
knocked onward past the carrier, away from the defender — deterministic scatter,
not random — and `defender.pressure` resets to `0`.

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

All checks below were run against the PR #3 branch
(`feature/deterministic-steal-pressure`, commit `8acfa2f`). They do **not** hold on
`main`, which still contains the random `trySteal` until PR #3 merges.

| Check | Method | Result |
|---|---|---|
| Syntax | `node -c game.js` | Pass |
| No randomness | `grep -n "Math.random" game.js` | Zero matches (on the PR #3 branch) |
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

Example at current values (60 fps). At 30 px, `proximity = (60 − 30) / 60 = 0.5`,
so per-frame pressure is `0.5` with a full lane block (`0.5 + 0.5 × 1`) and `0.25`
perpendicular (`0.5 + 0.5 × 0`):

| Scenario | Frames to steal | Wall-clock time |
|---|---|---|
| 30 px away, full lane block | 90 frames | ~1.5 s |
| 30 px away, perpendicular | 180 frames | ~3.0 s |

**2. Lane-bonus sign inversion (open defect)**

As implemented, the lane bonus rewards a defender positioned *behind* the carrier
relative to the attacking hoop, and gives zero bonus to a defender standing between
the carrier and the hoop — the inverse of the stated design intent (see
Implementation Contract → Core Functions). Determinism is unaffected, but the
incentive gradient is backwards: chasing beats blocking. The PR #3 rebase must
either flip the sign of the alignment term or explicitly adopt "pursuit pressure"
as the intended semantics and rename the term.

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

"""Defender belief state-machine transition function.

Pure and stateless: given a GameSnapshot, produces the next DefenderBelief
without mutating the input or relying on any external state. All arithmetic
uses Decimal so the output is deterministic across platforms and run order.

Design principles
-----------------
* No sqrt — hysteresis comparisons use squared distances, which is exact.
* Possession is a hard constraint: BALL_IN_FLIGHT locks out all
  GUARDING-family behavioral tracks before any threat calculation runs.
* Threat level is a composite of proximity-to-basket and attacker speed,
  each normalised to [0, 1] and clamped so extreme inputs can never escape
  the unit interval.
* Hysteresis on shading direction: a stationary attacker in mid-threat range
  holds the defender's last shading orientation rather than snapping to
  GUARDING on every frame.
"""

from __future__ import annotations

from decimal import Decimal

from engine.game_state import (
    DefenderBelief,
    DefenderMode,
    GameSnapshot,
    PossessionState,
    Vec2,
    fp,
)

# ---------------------------------------------------------------------------
# Court geometry
# ---------------------------------------------------------------------------

# Canonical basket position in court-space units.
# Half-court 1v1: court runs x ∈ [0, 15], y ∈ [-5, 5]; basket at far end.
BASKET = Vec2("7.500000", "0.000000")

# ---------------------------------------------------------------------------
# Distance thresholds (stored squared to avoid sqrt)
# ---------------------------------------------------------------------------

# Defender must be within this distance of the attacker to contest a shot.
CONTEST_DIST = fp("1.500000")
CONTEST_DIST_SQ = CONTEST_DIST * CONTEST_DIST  # 2.250000

# Defender beyond this distance from the attacker must recover position.
RECOVER_DIST = fp("4.000000")
RECOVER_DIST_SQ = RECOVER_DIST * RECOVER_DIST  # 16.000000

# ---------------------------------------------------------------------------
# Threat level parameters
# ---------------------------------------------------------------------------

# Composite threat = PROXIMITY_WEIGHT * proximity_threat + SPEED_WEIGHT * speed_threat
PROXIMITY_WEIGHT = fp("0.600000")
SPEED_WEIGHT = fp("0.400000")

# Normalisation denominators (squared)
_BASKET_MAX_DIST_SQ = fp("100.000000")  # attacker > 10 units away → zero proximity threat
_SPEED_MAX_SQ = fp("25.000000")         # attacker speed ≥ 5 units/frame → full speed threat

# Hysteresis thresholds — hard edges, no ramp.
HIGH_THREAT = fp("0.700000")  # ≥ this → CONTESTING (when close enough)
LOW_THREAT = fp("0.300000")   # ≤ this → GUARDING

# ---------------------------------------------------------------------------
# Intercept projection
# ---------------------------------------------------------------------------

INTERCEPT_FRAMES = Decimal("3")  # frames ahead to project for predicted intercept

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _dist_sq(a: Vec2, b: Vec2) -> Decimal:
    dx = a.x - b.x
    dy = a.y - b.y
    return dx * dx + dy * dy


def _clamp(value: Decimal, lo: Decimal, hi: Decimal) -> Decimal:
    if value < lo:
        return lo
    if value > hi:
        return hi
    return value


# ---------------------------------------------------------------------------
# Sub-computations (package-private — exposed for tests)
# ---------------------------------------------------------------------------


def _compute_threat_level(snapshot: GameSnapshot) -> Decimal:
    """Composite threat score in [0, 1].

    proximity_threat: how close the attacker is to the basket (closer = higher).
    speed_threat: how fast the attacker is moving (faster = higher).
    Both components are independently clamped before weighting so extreme
    positions or velocities cannot push the composite above 1.0.
    """
    pos = snapshot.attacker.kinematics.position
    vel = snapshot.attacker.kinematics.velocity

    basket_dist_sq = _dist_sq(pos, BASKET)
    proximity_raw = _BASKET_MAX_DIST_SQ - basket_dist_sq
    proximity_threat = _clamp(proximity_raw / _BASKET_MAX_DIST_SQ, Decimal("0"), Decimal("1"))

    speed_sq = vel.x * vel.x + vel.y * vel.y
    speed_threat = _clamp(speed_sq / _SPEED_MAX_SQ, Decimal("0"), Decimal("1"))

    raw = PROXIMITY_WEIGHT * proximity_threat + SPEED_WEIGHT * speed_threat
    return fp(_clamp(raw, Decimal("0"), Decimal("1")))


def _compute_predicted_intercept(snapshot: GameSnapshot) -> Vec2:
    """Project attacker INTERCEPT_FRAMES ahead along current velocity."""
    pos = snapshot.attacker.kinematics.position
    vel = snapshot.attacker.kinematics.velocity
    return Vec2(
        fp(pos.x + INTERCEPT_FRAMES * vel.x),
        fp(pos.y + INTERCEPT_FRAMES * vel.y),
    )


def _compute_mode(snapshot: GameSnapshot, threat_level: Decimal) -> DefenderMode:
    """Determine defender behavioral mode.

    Evaluation order (highest priority first):
    1. BALL_IN_FLIGHT possession — hard lock: only CONTESTING or RECOVERING.
    2. LOOSE_BALL possession — always RECOVERING.
    3. Defender is too far from attacker — RECOVERING regardless of threat.
    4. High threat — CONTESTING.
    5. Low threat — GUARDING.
    6. Mid-range threat — shade the attacker's velocity direction; hold last
       shading direction when attacker is stationary (hysteresis).
    """
    possession = snapshot.ball.possession
    dist_sq = _dist_sq(
        snapshot.defender.kinematics.position,
        snapshot.attacker.kinematics.position,
    )

    # --- Possession constraints ---
    if possession == PossessionState.BALL_IN_FLIGHT:
        return DefenderMode.CONTESTING if dist_sq <= CONTEST_DIST_SQ else DefenderMode.RECOVERING

    if possession == PossessionState.LOOSE_BALL:
        return DefenderMode.RECOVERING

    # --- ATTACKER has possession ---
    if dist_sq > RECOVER_DIST_SQ:
        return DefenderMode.RECOVERING

    if threat_level >= HIGH_THREAT:
        return DefenderMode.CONTESTING

    if threat_level <= LOW_THREAT:
        return DefenderMode.GUARDING

    # Mid-range threat: shade the direction the attacker is moving.
    vx = snapshot.attacker.kinematics.velocity.x
    if vx < fp("0.000000"):
        return DefenderMode.SHADING_LEFT
    if vx > fp("0.000000"):
        return DefenderMode.SHADING_RIGHT

    # Attacker is stationary in mid-threat range — hold prior shading orientation.
    prior = snapshot.defender.belief.mode
    if prior in (DefenderMode.SHADING_LEFT, DefenderMode.SHADING_RIGHT):
        return prior
    return DefenderMode.GUARDING


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def next_defender_belief(snapshot: GameSnapshot) -> DefenderBelief:
    """Compute the next DefenderBelief from a GameSnapshot.

    Pure and stateless: the input snapshot is never modified, and calling
    this function twice with the same snapshot produces the identical object.
    """
    threat_level = _compute_threat_level(snapshot)
    mode = _compute_mode(snapshot, threat_level)
    predicted_intercept = _compute_predicted_intercept(snapshot)
    return DefenderBelief(
        predicted_intercept=predicted_intercept,
        threat_level=threat_level,
        mode=mode,
    )

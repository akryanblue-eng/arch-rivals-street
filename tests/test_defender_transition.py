"""Defender belief state-machine transition validator.

Tests are organised into four groups:
  1. Purity guarantees (no mutation, determinism)
  2. Possession-rule constraints (BALL_IN_FLIGHT / LOOSE_BALL)
  3. Mode transition matrix (threat thresholds, shading, hysteresis)
  4. Threat level computation (proximity, speed, clamping, edge cases)
"""

from decimal import Decimal

import pytest

from engine.defender_transition import (
    BASKET,
    CONTEST_DIST_SQ,
    HIGH_THREAT,
    INTERCEPT_FRAMES,
    LOW_THREAT,
    RECOVER_DIST_SQ,
    _compute_threat_level,
    next_defender_belief,
)
from engine.game_state import (
    AttackerState,
    BallState,
    DefenderBelief,
    DefenderMode,
    DefenderState,
    GameSnapshot,
    Kinematics,
    PossessionState,
    Vec2,
    fp,
)

# ---------------------------------------------------------------------------
# Shared court-space landmarks (all in fixed-point strings)
# ---------------------------------------------------------------------------

_ZERO = Vec2("0.000000", "0.000000")
_ZERO_K = Kinematics(position=_ZERO, velocity=_ZERO, acceleration=_ZERO)

# Attacker positions relative to BASKET = (7.5, 0)
_AT_BASKET = Vec2("7.500000", "0.000000")       # dist_sq = 0
_NEAR_BASKET = Vec2("7.000000", "0.000000")      # dist_sq = 0.25
_MID_COURT = Vec2("3.750000", "0.000000")        # dist_sq = 14.0625
_FAR_FROM_BASKET = Vec2("0.000000", "0.000000")  # dist_sq = 56.25

# Velocity presets
_STILL = Vec2("0.000000", "0.000000")
_SLOW_LEFT = Vec2("-1.000000", "0.000000")
_SLOW_RIGHT = Vec2("1.000000", "0.000000")
_FAST_DIAGONAL = Vec2("4.000000", "3.000000")    # speed = 5, speed_sq = 25 → max threat


def _make_snap(
    *,
    attacker_pos: Vec2,
    attacker_vel: Vec2 = _STILL,
    defender_pos: Vec2,
    defender_vel: Vec2 = _STILL,
    possession: PossessionState = PossessionState.ATTACKER,
    current_mode: DefenderMode = DefenderMode.GUARDING,
    threat_level: str = "0.500000",
) -> GameSnapshot:
    return GameSnapshot(
        frame=0,
        attacker=AttackerState(
            kinematics=Kinematics(
                position=attacker_pos,
                velocity=attacker_vel,
                acceleration=_ZERO,
            )
        ),
        defender=DefenderState(
            kinematics=Kinematics(
                position=defender_pos,
                velocity=defender_vel,
                acceleration=_ZERO,
            ),
            belief=DefenderBelief(
                predicted_intercept=_ZERO,
                threat_level=fp(threat_level),
                mode=current_mode,
            ),
        ),
        ball=BallState(
            possession=possession,
            position=attacker_pos,
            velocity=_ZERO,
            launch_angle=fp("0.0"),
            spin=fp("0.0"),
        ),
    )


# ---------------------------------------------------------------------------
# 1. Purity guarantees
# ---------------------------------------------------------------------------


def test_next_belief_does_not_mutate_original_snapshot():
    snap = _make_snap(attacker_pos=_NEAR_BASKET, defender_pos=_NEAR_BASKET)
    original_mode = snap.defender.belief.mode
    original_threat = snap.defender.belief.threat_level
    next_defender_belief(snap)
    assert snap.defender.belief.mode == original_mode
    assert snap.defender.belief.threat_level == original_threat


def test_result_is_a_new_object():
    snap = _make_snap(attacker_pos=_NEAR_BASKET, defender_pos=_NEAR_BASKET)
    belief = next_defender_belief(snap)
    assert belief is not snap.defender.belief


def test_identical_snapshots_produce_identical_beliefs():
    snap_a = _make_snap(attacker_pos=_MID_COURT, attacker_vel=_SLOW_RIGHT, defender_pos=_ZERO)
    snap_b = _make_snap(attacker_pos=_MID_COURT, attacker_vel=_SLOW_RIGHT, defender_pos=_ZERO)
    assert next_defender_belief(snap_a) == next_defender_belief(snap_b)


def test_calling_twice_returns_same_belief():
    snap = _make_snap(attacker_pos=_NEAR_BASKET, attacker_vel=_FAST_DIAGONAL, defender_pos=_NEAR_BASKET)
    assert next_defender_belief(snap) == next_defender_belief(snap)


# ---------------------------------------------------------------------------
# 2. Possession-rule constraints
# ---------------------------------------------------------------------------


def test_ball_in_flight_close_defender_contests():
    # Defender within CONTEST_DIST of attacker must contest.
    snap = _make_snap(
        attacker_pos=_NEAR_BASKET,
        defender_pos=Vec2("7.200000", "0.000000"),  # dist ≈ 0.2 < 1.5
        possession=PossessionState.BALL_IN_FLIGHT,
    )
    assert next_defender_belief(snap).mode == DefenderMode.CONTESTING


def test_ball_in_flight_far_defender_recovers():
    # Defender far from attacker can only recover.
    snap = _make_snap(
        attacker_pos=_NEAR_BASKET,
        defender_pos=_FAR_FROM_BASKET,  # dist ≈ 7.5 >> 1.5
        possession=PossessionState.BALL_IN_FLIGHT,
    )
    assert next_defender_belief(snap).mode == DefenderMode.RECOVERING


@pytest.mark.parametrize("current_mode", list(DefenderMode))
def test_ball_in_flight_never_produces_guarding_family(current_mode):
    """BALL_IN_FLIGHT must lock out all GUARDING-track modes, regardless of
    what mode the defender was in previously."""
    snap = _make_snap(
        attacker_pos=_NEAR_BASKET,
        defender_pos=_FAR_FROM_BASKET,
        possession=PossessionState.BALL_IN_FLIGHT,
        current_mode=current_mode,
    )
    mode = next_defender_belief(snap).mode
    assert mode in (DefenderMode.CONTESTING, DefenderMode.RECOVERING)


def test_loose_ball_always_produces_recovering():
    snap = _make_snap(
        attacker_pos=_AT_BASKET,
        defender_pos=_AT_BASKET,  # even right on top of attacker
        possession=PossessionState.LOOSE_BALL,
    )
    assert next_defender_belief(snap).mode == DefenderMode.RECOVERING


def test_role_reversal_guarding_to_ball_in_flight_switches_mode():
    """Defender was calmly GUARDING; attacker just released a shot.
    The prior mode must not persist — possession rule overrides."""
    snap = _make_snap(
        attacker_pos=_NEAR_BASKET,
        defender_pos=Vec2("7.300000", "0.000000"),  # close → should contest
        possession=PossessionState.BALL_IN_FLIGHT,
        current_mode=DefenderMode.GUARDING,
    )
    belief = next_defender_belief(snap)
    assert belief.mode == DefenderMode.CONTESTING
    assert belief.mode != DefenderMode.GUARDING


# ---------------------------------------------------------------------------
# 3. Mode transition matrix
# ---------------------------------------------------------------------------


def test_attacker_beyond_recover_dist_forces_recovery():
    # dist_sq between (0,0) and (7.5,0) = 56.25 > RECOVER_DIST_SQ=16
    snap = _make_snap(
        attacker_pos=_NEAR_BASKET,
        defender_pos=_FAR_FROM_BASKET,
        possession=PossessionState.ATTACKER,
    )
    assert next_defender_belief(snap).mode == DefenderMode.RECOVERING


def test_high_threat_close_defender_contests():
    # Attacker AT basket + fast diagonal → threat > 0.70, defender close
    snap = _make_snap(
        attacker_pos=_AT_BASKET,
        attacker_vel=_FAST_DIAGONAL,          # speed_sq=25, speed_threat=1.0
        defender_pos=_AT_BASKET,              # dist_sq=0 → not in recovery zone
        possession=PossessionState.ATTACKER,
    )
    belief = next_defender_belief(snap)
    assert belief.threat_level >= HIGH_THREAT
    assert belief.mode == DefenderMode.CONTESTING


def test_low_threat_standing_far_guards():
    # Attacker far from basket, stationary → threat < LOW_THREAT
    snap = _make_snap(
        attacker_pos=_FAR_FROM_BASKET,
        attacker_vel=_STILL,
        defender_pos=_FAR_FROM_BASKET,        # same position → dist_sq=0
        possession=PossessionState.ATTACKER,
    )
    belief = next_defender_belief(snap)
    assert belief.threat_level <= LOW_THREAT
    assert belief.mode == DefenderMode.GUARDING


def test_mid_threat_moving_left_shades_left():
    # Mid-court, slow leftward velocity → mid-range threat, shade left
    snap = _make_snap(
        attacker_pos=_MID_COURT,
        attacker_vel=_SLOW_LEFT,
        defender_pos=_MID_COURT,
        possession=PossessionState.ATTACKER,
    )
    belief = next_defender_belief(snap)
    assert LOW_THREAT < belief.threat_level < HIGH_THREAT
    assert belief.mode == DefenderMode.SHADING_LEFT


def test_mid_threat_moving_right_shades_right():
    snap = _make_snap(
        attacker_pos=_MID_COURT,
        attacker_vel=_SLOW_RIGHT,
        defender_pos=_MID_COURT,
        possession=PossessionState.ATTACKER,
    )
    belief = next_defender_belief(snap)
    assert LOW_THREAT < belief.threat_level < HIGH_THREAT
    assert belief.mode == DefenderMode.SHADING_RIGHT


def test_stationary_attacker_hysteresis_holds_shading_left():
    """Attacker stops in mid-threat zone; defender held SHADING_LEFT last
    frame — it must hold that orientation, not snap back to GUARDING."""
    snap = _make_snap(
        attacker_pos=_MID_COURT,
        attacker_vel=_STILL,
        defender_pos=_MID_COURT,
        current_mode=DefenderMode.SHADING_LEFT,
        possession=PossessionState.ATTACKER,
    )
    assert next_defender_belief(snap).mode == DefenderMode.SHADING_LEFT


def test_stationary_attacker_hysteresis_holds_shading_right():
    snap = _make_snap(
        attacker_pos=_MID_COURT,
        attacker_vel=_STILL,
        defender_pos=_MID_COURT,
        current_mode=DefenderMode.SHADING_RIGHT,
        possession=PossessionState.ATTACKER,
    )
    assert next_defender_belief(snap).mode == DefenderMode.SHADING_RIGHT


def test_stationary_attacker_no_prior_shading_stays_guarding():
    """When the attacker stops and there's no prior shading orientation,
    the defender falls back to GUARDING — not an arbitrary mode."""
    snap = _make_snap(
        attacker_pos=_MID_COURT,
        attacker_vel=_STILL,
        defender_pos=_MID_COURT,
        current_mode=DefenderMode.GUARDING,
        possession=PossessionState.ATTACKER,
    )
    assert next_defender_belief(snap).mode == DefenderMode.GUARDING


def test_high_threat_threshold_exact_boundary_is_contesting():
    # Attacker AT basket (proximity_threat=1.0), vel=(2.5,0):
    #   speed_sq = 6.25, speed_threat = 0.25
    #   threat = 0.6*1.0 + 0.4*0.25 = 0.70 exactly → CONTESTING
    snap = _make_snap(
        attacker_pos=_AT_BASKET,
        attacker_vel=Vec2("2.500000", "0.000000"),
        defender_pos=_AT_BASKET,
        possession=PossessionState.ATTACKER,
    )
    belief = next_defender_belief(snap)
    assert belief.threat_level == HIGH_THREAT
    assert belief.mode == DefenderMode.CONTESTING


def test_just_below_high_threat_shades_not_contests():
    # Same position, slightly slower (vel.x = 2.4):
    #   speed_sq = 5.76, speed_threat = 0.2304
    #   threat = 0.6 + 0.4*0.2304 = 0.69216 < HIGH_THREAT → shade
    snap = _make_snap(
        attacker_pos=_AT_BASKET,
        attacker_vel=Vec2("2.400000", "0.000000"),  # moving right
        defender_pos=_AT_BASKET,
        possession=PossessionState.ATTACKER,
    )
    belief = next_defender_belief(snap)
    assert belief.threat_level < HIGH_THREAT
    assert belief.mode == DefenderMode.SHADING_RIGHT  # vel.x > 0


# ---------------------------------------------------------------------------
# 4. Threat level computation
# ---------------------------------------------------------------------------


def test_threat_level_always_in_unit_interval():
    cases = [
        (_AT_BASKET, _FAST_DIAGONAL),
        (_FAR_FROM_BASKET, _STILL),
        (Vec2("100.000000", "100.000000"), Vec2("100.000000", "100.000000")),  # out of bounds
        (_AT_BASKET, _STILL),
        (_MID_COURT, _SLOW_LEFT),
    ]
    for pos, vel in cases:
        snap = _make_snap(attacker_pos=pos, attacker_vel=vel, defender_pos=_ZERO)
        tl = _compute_threat_level(snap)
        assert fp("0.0") <= tl <= fp("1.0"), f"threat {tl} out of range for pos={pos}, vel={vel}"


def test_threat_increases_as_attacker_approaches_basket():
    far_snap = _make_snap(attacker_pos=_FAR_FROM_BASKET, defender_pos=_ZERO)
    mid_snap = _make_snap(attacker_pos=_MID_COURT, defender_pos=_ZERO)
    near_snap = _make_snap(attacker_pos=_NEAR_BASKET, defender_pos=_ZERO)
    tl_far = _compute_threat_level(far_snap)
    tl_mid = _compute_threat_level(mid_snap)
    tl_near = _compute_threat_level(near_snap)
    assert tl_far < tl_mid < tl_near


def test_threat_increases_with_attacker_speed():
    slow_snap = _make_snap(attacker_pos=_MID_COURT, attacker_vel=_SLOW_RIGHT, defender_pos=_ZERO)
    fast_snap = _make_snap(attacker_pos=_MID_COURT, attacker_vel=_FAST_DIAGONAL, defender_pos=_ZERO)
    assert _compute_threat_level(slow_snap) < _compute_threat_level(fast_snap)


def test_extreme_speed_does_not_exceed_ceiling():
    snap = _make_snap(
        attacker_pos=_AT_BASKET,
        attacker_vel=Vec2("100.000000", "100.000000"),
        defender_pos=_ZERO,
    )
    assert _compute_threat_level(snap) <= fp("1.0")


def test_out_of_bounds_position_threat_is_clamped_to_zero_proximity():
    """An attacker impossibly far from the basket has zero proximity threat;
    overall threat comes only from speed, and is still in [0, 1]."""
    snap = _make_snap(
        attacker_pos=Vec2("1000.000000", "1000.000000"),
        attacker_vel=_STILL,
        defender_pos=_ZERO,
    )
    tl = _compute_threat_level(snap)
    assert tl == fp("0.0")  # proximity=0, speed=0


# ---------------------------------------------------------------------------
# 5. Predicted intercept computation
# ---------------------------------------------------------------------------


def test_predicted_intercept_is_exact_lookahead():
    pos = Vec2("3.000000", "2.000000")
    vel = Vec2("1.000000", "-0.500000")
    snap = _make_snap(attacker_pos=pos, attacker_vel=vel, defender_pos=_ZERO)
    belief = next_defender_belief(snap)
    expected = Vec2(
        fp(pos.x + INTERCEPT_FRAMES * vel.x),
        fp(pos.y + INTERCEPT_FRAMES * vel.y),
    )
    assert belief.predicted_intercept == expected


def test_predicted_intercept_for_stationary_attacker_equals_position():
    snap = _make_snap(attacker_pos=_MID_COURT, attacker_vel=_STILL, defender_pos=_ZERO)
    belief = next_defender_belief(snap)
    assert belief.predicted_intercept == _MID_COURT

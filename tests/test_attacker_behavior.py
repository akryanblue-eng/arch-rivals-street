"""Tests for the attacker intent state machine."""

from decimal import Decimal

import pytest

from engine.attacker_behavior import (
    DECEL_FACTOR,
    DRIVE_STEP,
    MAX_VEL_COMPONENT,
    SHOOT_THREAT_THRESHOLD,
    next_attacker_intent,
)
from engine.defender_transition import BASKET
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
# Helpers
# ---------------------------------------------------------------------------

_ZERO = Vec2("0.000000", "0.000000")
_ZERO_K = Kinematics(position=_ZERO, velocity=_ZERO, acceleration=_ZERO)


def _make_snap(
    *,
    attacker_pos: Vec2 = _ZERO,
    attacker_vel: Vec2 = _ZERO,
    possession: PossessionState = PossessionState.ATTACKER,
    threat_level: str = "0.300000",  # low by default
    defender_mode: DefenderMode = DefenderMode.GUARDING,
) -> GameSnapshot:
    return GameSnapshot(
        frame=0,
        attacker=AttackerState(
            kinematics=Kinematics(position=attacker_pos, velocity=attacker_vel, acceleration=_ZERO)
        ),
        defender=DefenderState(
            kinematics=_ZERO_K,
            belief=DefenderBelief(
                predicted_intercept=_ZERO,
                threat_level=fp(threat_level),
                mode=defender_mode,
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
# 1. Purity
# ---------------------------------------------------------------------------


def test_intent_does_not_mutate_snapshot():
    snap = _make_snap()
    before_vel = snap.attacker.kinematics.velocity
    next_attacker_intent(snap)
    assert snap.attacker.kinematics.velocity == before_vel


def test_result_is_a_new_kinematics_object():
    snap = _make_snap()
    result = next_attacker_intent(snap)
    assert result is not snap.attacker.kinematics


def test_identical_snapshots_produce_identical_intent():
    a = _make_snap(attacker_pos=Vec2("2.0", "1.0"), attacker_vel=Vec2("0.5", "0.0"))
    b = _make_snap(attacker_pos=Vec2("2.0", "1.0"), attacker_vel=Vec2("0.5", "0.0"))
    assert next_attacker_intent(a) == next_attacker_intent(b)


def test_calling_twice_returns_same_intent():
    snap = _make_snap()
    assert next_attacker_intent(snap) == next_attacker_intent(snap)


def test_position_is_unchanged_in_returned_kinematics():
    """Position update is the frame stepper's job, not attacker intent."""
    pos = Vec2("3.000000", "1.500000")
    snap = _make_snap(attacker_pos=pos)
    result = next_attacker_intent(snap)
    assert result.position == pos


# ---------------------------------------------------------------------------
# 2. No-possession: deceleration
# ---------------------------------------------------------------------------


def test_ball_in_flight_decelerates_velocity():
    snap = _make_snap(
        attacker_vel=Vec2("2.000000", "1.000000"),
        possession=PossessionState.BALL_IN_FLIGHT,
    )
    result = next_attacker_intent(snap)
    assert result.velocity.x == fp(fp("2.0") * DECEL_FACTOR)
    assert result.velocity.y == fp(fp("1.0") * DECEL_FACTOR)


def test_loose_ball_also_decelerates():
    snap = _make_snap(
        attacker_vel=Vec2("2.000000", "1.000000"),
        possession=PossessionState.LOOSE_BALL,
    )
    result = next_attacker_intent(snap)
    assert result.velocity.x == fp(fp("2.0") * DECEL_FACTOR)
    assert result.velocity.y == fp(fp("1.0") * DECEL_FACTOR)


def test_deceleration_is_exact_fixed_point():
    snap = _make_snap(
        attacker_vel=Vec2("4.000000", "0.000000"),
        possession=PossessionState.BALL_IN_FLIGHT,
    )
    result = next_attacker_intent(snap)
    assert result.velocity.x == fp("3.400000")  # 4.0 * 0.85 exactly


def test_stationary_attacker_with_no_possession_stays_stationary():
    snap = _make_snap(attacker_vel=_ZERO, possession=PossessionState.BALL_IN_FLIGHT)
    result = next_attacker_intent(snap)
    assert result.velocity == _ZERO


# ---------------------------------------------------------------------------
# 3. Drive toward basket (low threat)
# ---------------------------------------------------------------------------


def test_drives_toward_basket_x_when_left_of_basket():
    # Attacker at (0, 0); basket at (7.5, 0): dx > 0 → step_x positive
    snap = _make_snap(attacker_pos=Vec2("0.000000", "2.000000"), threat_level="0.200000")
    result = next_attacker_intent(snap)
    assert result.velocity.x > fp("0.0")  # moved toward basket in x


def test_drives_away_from_basket_x_when_right_of_basket():
    # Attacker past basket: dx < 0 → step_x negative
    snap = _make_snap(attacker_pos=Vec2("10.000000", "0.000000"), threat_level="0.200000")
    result = next_attacker_intent(snap)
    assert result.velocity.x < fp("0.0")


def test_drive_step_is_exactly_drive_step_constant():
    snap = _make_snap(attacker_pos=Vec2("0.000000", "0.000000"), threat_level="0.100000")
    result = next_attacker_intent(snap)
    # From (0,0) with zero velocity: new velocity x == DRIVE_STEP
    assert result.velocity.x == DRIVE_STEP


# ---------------------------------------------------------------------------
# 4. Evasion (high threat)
# ---------------------------------------------------------------------------


def test_high_threat_produces_lateral_evasion():
    # Attacker at (0, 2): basket vector is (7.5, -2), perpendicular is (2, 7.5)
    # With threat > SHOOT_THREAT_THRESHOLD: step_y should be positive (target_y = 7.5)
    snap = _make_snap(
        attacker_pos=Vec2("0.000000", "2.000000"),
        threat_level="0.800000",
    )
    low_snap = _make_snap(
        attacker_pos=Vec2("0.000000", "2.000000"),
        threat_level="0.200000",
    )
    drive_result = next_attacker_intent(low_snap)
    evade_result = next_attacker_intent(snap)
    # Drive: step_y negative (dy = 0 - 2 = -2 < 0)
    # Evade: step_y positive (target_y = dx = 7.5 > 0)
    assert drive_result.velocity.y < fp("0.0")
    assert evade_result.velocity.y > fp("0.0")


@pytest.mark.parametrize("threat", ["0.750001", "0.900000", "1.000000"])
def test_above_threshold_always_evades(threat):
    snap_high = _make_snap(
        attacker_pos=Vec2("0.000000", "2.000000"),
        threat_level=threat,
    )
    snap_low = _make_snap(
        attacker_pos=Vec2("0.000000", "2.000000"),
        threat_level="0.100000",
    )
    # Evasion and drive should produce different velocity.y signs
    high_vy = next_attacker_intent(snap_high).velocity.y
    low_vy = next_attacker_intent(snap_low).velocity.y
    assert high_vy != low_vy


# ---------------------------------------------------------------------------
# 5. Velocity clamping
# ---------------------------------------------------------------------------


def test_velocity_clamped_at_max_positive():
    snap = _make_snap(
        attacker_pos=Vec2("0.000000", "0.000000"),
        attacker_vel=Vec2("3.000000", "0.000000"),  # already at max
        threat_level="0.100000",
    )
    result = next_attacker_intent(snap)
    assert result.velocity.x == MAX_VEL_COMPONENT


def test_velocity_clamped_at_max_negative():
    snap = _make_snap(
        attacker_pos=Vec2("10.000000", "0.000000"),  # past basket → step_x negative
        attacker_vel=Vec2("-3.000000", "0.000000"),
        threat_level="0.100000",
    )
    result = next_attacker_intent(snap)
    assert result.velocity.x == -MAX_VEL_COMPONENT


def test_velocity_accumulates_across_frames_up_to_cap():
    snap = _make_snap(attacker_pos=Vec2("0.000000", "0.000000"), threat_level="0.100000")
    for _ in range(20):  # 20 steps of +DRIVE_STEP each
        intent = next_attacker_intent(snap)
        from engine.game_state import AttackerState, Kinematics
        from dataclasses import replace as _replace
        snap = GameSnapshot(
            frame=snap.frame + 1,
            attacker=AttackerState(kinematics=intent),
            defender=snap.defender,
            ball=snap.ball,
        )
    final_intent = next_attacker_intent(snap)
    assert final_intent.velocity.x == MAX_VEL_COMPONENT

"""Layer 2: Transition invariants.

Every test here asserts a hard structural constraint that must hold for ANY
valid snapshot pair (s, step_frame(s)).  These are engine-wide invariants,
not behavioral assertions about specific strategies.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from engine.frame_stepper import (
    BALL_FRICTION,
    COURT_MAX_X,
    COURT_MAX_Y,
    COURT_MIN_X,
    COURT_MIN_Y,
    GRAVITY,
    step_frame,
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
# Helpers
# ---------------------------------------------------------------------------

_ZERO = Vec2("0.000000", "0.000000")
_ZERO_K = Kinematics(position=_ZERO, velocity=_ZERO, acceleration=_ZERO)


def _make_snap(
    *,
    attacker_pos: Vec2 = _ZERO,
    attacker_vel: Vec2 = _ZERO,
    defender_pos: Vec2 = _ZERO,
    defender_vel: Vec2 = _ZERO,
    possession: PossessionState = PossessionState.ATTACKER,
    ball_pos: Vec2 = _ZERO,
    ball_vel: Vec2 = _ZERO,
    threat_level: str = "0.300000",
    defender_mode: DefenderMode = DefenderMode.GUARDING,
    frame: int = 0,
) -> GameSnapshot:
    return GameSnapshot(
        frame=frame,
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
                mode=defender_mode,
            ),
        ),
        ball=BallState(
            possession=possession,
            position=ball_pos,
            velocity=ball_vel,
            launch_angle=fp("0.0"),
            spin=fp("0.0"),
        ),
    )


# ---------------------------------------------------------------------------
# 1. Court boundary clamping — all positions always within legal court bounds
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("pos_x", ["-100.0", "-15.0", "0.0", "15.0", "100.0"])
@pytest.mark.parametrize("vel_x", ["-5.0", "0.0", "5.0"])
def test_attacker_x_always_within_court(pos_x, vel_x):
    snap = _make_snap(
        attacker_pos=Vec2(pos_x, "0.0"),
        attacker_vel=Vec2(vel_x, "0.0"),
    )
    result = step_frame(snap)
    assert COURT_MIN_X <= result.attacker.kinematics.position.x <= COURT_MAX_X


@pytest.mark.parametrize("pos_y", ["-100.0", "-5.0", "0.0", "5.0", "100.0"])
@pytest.mark.parametrize("vel_y", ["-5.0", "0.0", "5.0"])
def test_attacker_y_always_within_court(pos_y, vel_y):
    snap = _make_snap(
        attacker_pos=Vec2("0.0", pos_y),
        attacker_vel=Vec2("0.0", vel_y),
    )
    result = step_frame(snap)
    assert COURT_MIN_Y <= result.attacker.kinematics.position.y <= COURT_MAX_Y


@pytest.mark.parametrize("pos_x", ["-100.0", "-15.0", "0.0", "15.0", "100.0"])
@pytest.mark.parametrize("vel_x", ["-5.0", "0.0", "5.0"])
def test_defender_x_always_within_court(pos_x, vel_x):
    snap = _make_snap(
        defender_pos=Vec2(pos_x, "0.0"),
        defender_vel=Vec2(vel_x, "0.0"),
    )
    result = step_frame(snap)
    assert COURT_MIN_X <= result.defender.kinematics.position.x <= COURT_MAX_X


@pytest.mark.parametrize("pos_y", ["-100.0", "-5.0", "0.0", "5.0", "100.0"])
@pytest.mark.parametrize("vel_y", ["-5.0", "0.0", "5.0"])
def test_defender_y_always_within_court(pos_y, vel_y):
    snap = _make_snap(
        defender_pos=Vec2("0.0", pos_y),
        defender_vel=Vec2("0.0", vel_y),
    )
    result = step_frame(snap)
    assert COURT_MIN_Y <= result.defender.kinematics.position.y <= COURT_MAX_Y


def test_attacker_clamped_at_exact_min_x_boundary():
    snap = _make_snap(
        attacker_pos=Vec2("-14.800000", "0.000000"),
        attacker_vel=Vec2("-3.000000", "0.000000"),
    )
    assert step_frame(snap).attacker.kinematics.position.x == COURT_MIN_X


def test_attacker_clamped_at_exact_max_x_boundary():
    snap = _make_snap(
        attacker_pos=Vec2("14.800000", "0.000000"),
        attacker_vel=Vec2("3.000000", "0.000000"),
        threat_level="0.100000",
    )
    assert step_frame(snap).attacker.kinematics.position.x <= COURT_MAX_X


# ---------------------------------------------------------------------------
# 2. Possession lock during BALL_IN_FLIGHT and LOOSE_BALL
# ---------------------------------------------------------------------------


def test_ball_in_flight_possession_unchanged():
    snap = _make_snap(possession=PossessionState.BALL_IN_FLIGHT)
    assert step_frame(snap).ball.possession == PossessionState.BALL_IN_FLIGHT


def test_loose_ball_possession_unchanged():
    snap = _make_snap(possession=PossessionState.LOOSE_BALL)
    assert step_frame(snap).ball.possession == PossessionState.LOOSE_BALL


def test_attacker_possession_unchanged():
    snap = _make_snap(possession=PossessionState.ATTACKER)
    assert step_frame(snap).ball.possession == PossessionState.ATTACKER


@pytest.mark.parametrize("possession", list(PossessionState))
def test_possession_never_changes_without_explicit_event(possession):
    """step_frame has no possession-change logic; the possession field must
    pass through unchanged on every call."""
    snap = _make_snap(possession=possession)
    assert step_frame(snap).ball.possession == possession


# ---------------------------------------------------------------------------
# 3. Flight physics invariants
# ---------------------------------------------------------------------------


def test_ball_in_flight_horizontal_velocity_unchanged():
    snap = _make_snap(
        possession=PossessionState.BALL_IN_FLIGHT,
        ball_vel=Vec2("2.500000", "1.000000"),
    )
    result = step_frame(snap)
    assert result.ball.velocity.x == fp("2.500000")


def test_ball_in_flight_vertical_velocity_decreases_by_gravity():
    initial_vy = fp("3.000000")
    snap = _make_snap(
        possession=PossessionState.BALL_IN_FLIGHT,
        ball_vel=Vec2("0.000000", str(initial_vy)),
    )
    result = step_frame(snap)
    assert result.ball.velocity.y == fp(initial_vy - GRAVITY)


def test_ball_in_flight_gravity_is_monotonically_decreasing():
    """Vertical velocity must decrease by exactly GRAVITY each frame."""
    snap = _make_snap(
        possession=PossessionState.BALL_IN_FLIGHT,
        ball_vel=Vec2("0.000000", "5.000000"),
    )
    prev_vy = snap.ball.velocity.y
    for _ in range(10):
        snap = step_frame(snap)
        assert snap.ball.velocity.y == fp(prev_vy - GRAVITY)
        prev_vy = snap.ball.velocity.y


def test_ball_in_flight_position_advances_by_new_velocity():
    snap = _make_snap(
        possession=PossessionState.BALL_IN_FLIGHT,
        ball_pos=Vec2("3.000000", "2.000000"),
        ball_vel=Vec2("1.000000", "1.000000"),
    )
    result = step_frame(snap)
    new_vx = fp("1.000000")
    new_vy = fp(fp("1.000000") - GRAVITY)
    assert result.ball.position.x == fp(fp("3.000000") + new_vx)
    assert result.ball.position.y == fp(fp("2.000000") + new_vy)


def test_ball_in_flight_position_uses_new_not_old_velocity():
    """Position update uses velocity AFTER gravity is applied, not before."""
    snap = _make_snap(
        possession=PossessionState.BALL_IN_FLIGHT,
        ball_pos=Vec2("0.000000", "0.000000"),
        ball_vel=Vec2("0.000000", "1.000000"),
    )
    result = step_frame(snap)
    expected_y = fp(fp("1.000000") - GRAVITY)  # new vy applied to old pos
    assert result.ball.position.y == expected_y


# ---------------------------------------------------------------------------
# 4. Loose ball physics invariants
# ---------------------------------------------------------------------------


def test_loose_ball_velocity_decays_by_friction_factor():
    snap = _make_snap(
        possession=PossessionState.LOOSE_BALL,
        ball_vel=Vec2("4.000000", "2.000000"),
    )
    result = step_frame(snap)
    assert result.ball.velocity.x == fp(fp("4.000000") * BALL_FRICTION)
    assert result.ball.velocity.y == fp(fp("2.000000") * BALL_FRICTION)


def test_loose_ball_velocity_never_grows():
    """Each frame's velocity magnitude must be ≤ the previous frame's."""
    snap = _make_snap(
        possession=PossessionState.LOOSE_BALL,
        ball_vel=Vec2("3.000000", "2.000000"),
    )
    prev_vx = snap.ball.velocity.x.copy_abs()
    prev_vy = snap.ball.velocity.y.copy_abs()
    for _ in range(30):
        snap = step_frame(snap)
        assert snap.ball.velocity.x.copy_abs() <= prev_vx
        assert snap.ball.velocity.y.copy_abs() <= prev_vy
        prev_vx = snap.ball.velocity.x.copy_abs()
        prev_vy = snap.ball.velocity.y.copy_abs()


def test_loose_ball_velocity_asymptotically_approaches_zero():
    snap = _make_snap(
        possession=PossessionState.LOOSE_BALL,
        ball_vel=Vec2("10.000000", "10.000000"),
    )
    for _ in range(100):
        snap = step_frame(snap)
    assert snap.ball.velocity.x < fp("0.001000")
    assert snap.ball.velocity.y < fp("0.001000")


def test_loose_ball_stationary_stays_stationary():
    snap = _make_snap(
        possession=PossessionState.LOOSE_BALL,
        ball_vel=Vec2("0.000000", "0.000000"),
    )
    result = step_frame(snap)
    assert result.ball.velocity == Vec2("0.000000", "0.000000")


# ---------------------------------------------------------------------------
# 5. Defender belief state invariants
# ---------------------------------------------------------------------------


def test_threat_level_always_in_unit_interval():
    scenarios = [
        dict(attacker_pos=Vec2("7.500000", "0.000000"), attacker_vel=Vec2("4.000000", "3.000000")),
        dict(attacker_pos=Vec2("0.000000", "0.000000"), attacker_vel=Vec2("0.000000", "0.000000")),
        dict(attacker_pos=Vec2("1000.000000", "1000.000000")),
        dict(threat_level="0.999999"),
        dict(threat_level="0.000001"),
    ]
    for kwargs in scenarios:
        snap = _make_snap(**kwargs)
        result = step_frame(snap)
        tl = result.defender.belief.threat_level
        assert fp("0.0") <= tl <= fp("1.0"), f"threat {tl} out of range"


def test_defender_mode_is_always_a_valid_enum():
    for mode in DefenderMode:
        snap = _make_snap(defender_mode=mode)
        result = step_frame(snap)
        assert isinstance(result.defender.belief.mode, DefenderMode)


def test_ball_in_flight_defender_mode_never_guarding():
    """During flight, the defender must be CONTESTING or RECOVERING, never
    one of the possession-guarding modes."""
    positions = [
        Vec2("0.000000", "0.000000"),
        Vec2("7.500000", "0.000000"),
        Vec2("7.000000", "0.000000"),
        Vec2("14.000000", "0.000000"),
    ]
    for defender_pos in positions:
        snap = _make_snap(
            possession=PossessionState.BALL_IN_FLIGHT,
            defender_pos=defender_pos,
        )
        mode = step_frame(snap).defender.belief.mode
        assert mode in (DefenderMode.CONTESTING, DefenderMode.RECOVERING), (
            f"unexpected mode {mode} for defender at {defender_pos}"
        )


def test_loose_ball_defender_always_recovering():
    positions = [
        Vec2("0.000000", "0.000000"),
        Vec2("7.500000", "0.000000"),
        Vec2("7.000000", "0.000000"),
    ]
    for defender_pos in positions:
        snap = _make_snap(
            possession=PossessionState.LOOSE_BALL,
            defender_pos=defender_pos,
        )
        mode = step_frame(snap).defender.belief.mode
        assert mode == DefenderMode.RECOVERING, (
            f"expected RECOVERING, got {mode} for defender at {defender_pos}"
        )


def test_defender_belief_is_a_new_object_each_frame():
    snap = _make_snap()
    result = step_frame(snap)
    assert result.defender.belief is not snap.defender.belief


# ---------------------------------------------------------------------------
# 6. Frame monotonicity
# ---------------------------------------------------------------------------


def test_frame_always_increments():
    snap = _make_snap(frame=0)
    for i in range(1, 101):
        snap = step_frame(snap)
        assert snap.frame == i


@pytest.mark.parametrize("start_frame", [0, 1, 100, 999, 10_000])
def test_frame_increments_from_arbitrary_start(start_frame):
    snap = _make_snap(frame=start_frame)
    result = step_frame(snap)
    assert result.frame == start_frame + 1


def test_frame_monotonicity_holds_with_mid_sequence_possession_change():
    """Frame must increment even when possession state switches between steps."""
    snap = _make_snap(frame=0, possession=PossessionState.ATTACKER)
    snap = step_frame(snap)
    assert snap.frame == 1
    snap2 = GameSnapshot(
        frame=snap.frame,
        attacker=snap.attacker,
        defender=snap.defender,
        ball=BallState(
            possession=PossessionState.BALL_IN_FLIGHT,
            position=snap.ball.position,
            velocity=Vec2("1.000000", "2.000000"),
            launch_angle=fp("0.5"),
            spin=fp("0.0"),
        ),
    )
    snap3 = step_frame(snap2)
    assert snap3.frame == 2


# ---------------------------------------------------------------------------
# 7. Output schema validity
# ---------------------------------------------------------------------------


def test_every_step_produces_validate_snapshot_conformant_output():
    from engine.game_state import validate_snapshot

    snap = _make_snap(
        attacker_pos=Vec2("2.000000", "1.000000"),
        attacker_vel=Vec2("1.000000", "0.500000"),
        threat_level="0.500000",
    )
    for _ in range(50):
        snap = step_frame(snap)
        validate_snapshot(snap)  # raises on any violation


def test_from_json_round_trip_produces_validate_conformant_snapshot():
    from engine.game_state import validate_snapshot

    snap = step_frame(_make_snap())
    restored = GameSnapshot.from_json(snap.to_json())
    validate_snapshot(restored)

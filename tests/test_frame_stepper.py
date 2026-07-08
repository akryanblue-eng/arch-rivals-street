"""Tests for the deterministic frame stepper."""

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
    validate_snapshot,
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
    frame: int = 0,
) -> GameSnapshot:
    return GameSnapshot(
        frame=frame,
        attacker=AttackerState(
            kinematics=Kinematics(position=attacker_pos, velocity=attacker_vel, acceleration=_ZERO)
        ),
        defender=DefenderState(
            kinematics=Kinematics(position=defender_pos, velocity=defender_vel, acceleration=_ZERO),
            belief=DefenderBelief(
                predicted_intercept=_ZERO,
                threat_level=fp(threat_level),
                mode=DefenderMode.GUARDING,
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
# 1. Purity and framing
# ---------------------------------------------------------------------------


def test_step_frame_does_not_mutate_input_snapshot():
    snap = _make_snap()
    original_frame = snap.frame
    original_pos = snap.attacker.kinematics.position
    step_frame(snap)
    assert snap.frame == original_frame
    assert snap.attacker.kinematics.position == original_pos


def test_step_frame_returns_new_snapshot_object():
    snap = _make_snap()
    result = step_frame(snap)
    assert result is not snap


def test_step_frame_increments_frame_number():
    snap = _make_snap(frame=7)
    assert step_frame(snap).frame == 8


def test_frame_number_monotonically_increases_over_n_steps():
    snap = _make_snap(frame=0)
    for expected in range(1, 11):
        snap = step_frame(snap)
        assert snap.frame == expected


def test_deterministic_identical_inputs_produce_identical_outputs():
    a = _make_snap(attacker_pos=Vec2("1.0", "0.0"), attacker_vel=Vec2("0.5", "0.0"))
    b = _make_snap(attacker_pos=Vec2("1.0", "0.0"), attacker_vel=Vec2("0.5", "0.0"))
    assert step_frame(a) == step_frame(b)


def test_deterministic_multi_step_two_runs_converge():
    """Run 15 frames from the same seed twice; results must be identical."""
    def run(n: int) -> GameSnapshot:
        s = _make_snap(attacker_pos=Vec2("0.0", "0.0"), threat_level="0.400000")
        for _ in range(n):
            s = step_frame(s)
        return s
    assert run(15) == run(15)


def test_output_validates_against_game_state_schema():
    snap = _make_snap()
    result = step_frame(snap)
    validate_snapshot(result)  # raises if invalid


# ---------------------------------------------------------------------------
# 2. Attacker kinematics integration
# ---------------------------------------------------------------------------


def test_attacker_position_updates_from_new_velocity():
    # Attacker at (0,0) with vel (1.5,0), low threat: intent adds DRIVE_STEP to vel
    # Expected new vel.x = 1.5 + 0.5 = 2.0; new pos.x = 0 + 2.0 = 2.0
    snap = _make_snap(
        attacker_pos=Vec2("0.000000", "0.000000"),
        attacker_vel=Vec2("1.500000", "0.000000"),
        threat_level="0.100000",
    )
    result = step_frame(snap)
    assert result.attacker.kinematics.position.x == fp("2.0")


def test_attacker_velocity_carried_into_output():
    snap = _make_snap(
        attacker_pos=Vec2("0.000000", "0.000000"),
        attacker_vel=Vec2("0.000000", "0.000000"),
        threat_level="0.100000",
    )
    from engine.attacker_behavior import next_attacker_intent
    expected_vel = next_attacker_intent(snap).velocity
    result = step_frame(snap)
    assert result.attacker.kinematics.velocity == expected_vel


# ---------------------------------------------------------------------------
# 3. Court boundary clamping
# ---------------------------------------------------------------------------


def test_attacker_position_clamped_at_max_x():
    # Attacker near right boundary with positive velocity that would overshoot
    snap = _make_snap(
        attacker_pos=Vec2("14.800000", "0.000000"),
        attacker_vel=Vec2("3.000000", "0.000000"),  # at MAX_VEL_COMPONENT
        threat_level="0.100000",
    )
    result = step_frame(snap)
    assert result.attacker.kinematics.position.x <= COURT_MAX_X


def test_attacker_position_clamped_at_max_y():
    # High y-position + velocity that would cross COURT_MAX_Y
    snap = _make_snap(
        attacker_pos=Vec2("0.000000", "4.900000"),
        attacker_vel=Vec2("0.000000", "3.000000"),
        threat_level="0.100000",
    )
    result = step_frame(snap)
    assert result.attacker.kinematics.position.y <= COURT_MAX_Y


def test_attacker_position_clamped_at_min_y():
    snap = _make_snap(
        attacker_pos=Vec2("0.000000", "-4.900000"),
        attacker_vel=Vec2("0.000000", "-3.000000"),
        threat_level="0.100000",
    )
    result = step_frame(snap)
    assert result.attacker.kinematics.position.y >= COURT_MIN_Y


# ---------------------------------------------------------------------------
# 4. Defender kinematics integration
# ---------------------------------------------------------------------------


def test_defender_position_updates_from_current_velocity():
    snap = _make_snap(
        defender_pos=Vec2("2.000000", "1.000000"),
        defender_vel=Vec2("0.500000", "-0.500000"),
    )
    result = step_frame(snap)
    assert result.defender.kinematics.position.x == fp("2.5")
    assert result.defender.kinematics.position.y == fp("0.5")


def test_defender_position_clamped_at_court_bounds():
    snap = _make_snap(
        defender_pos=Vec2("14.800000", "0.000000"),
        defender_vel=Vec2("3.000000", "0.000000"),
    )
    result = step_frame(snap)
    assert result.defender.kinematics.position.x <= COURT_MAX_X


# ---------------------------------------------------------------------------
# 5. Ball state resolution
# ---------------------------------------------------------------------------


def test_ball_tracks_attacker_when_in_possession():
    snap = _make_snap(
        attacker_pos=Vec2("3.000000", "0.000000"),
        possession=PossessionState.ATTACKER,
    )
    result = step_frame(snap)
    assert result.ball.position == result.attacker.kinematics.position


def test_ball_in_flight_velocity_decreases_by_gravity():
    initial_vy = fp("2.000000")
    snap = _make_snap(
        possession=PossessionState.BALL_IN_FLIGHT,
        ball_vel=Vec2("1.500000", str(initial_vy)),
    )
    result = step_frame(snap)
    assert result.ball.velocity.y == fp(initial_vy - GRAVITY)
    assert result.ball.velocity.x == fp("1.5")  # horizontal unchanged


def test_ball_in_flight_position_advances_from_velocity():
    snap = _make_snap(
        possession=PossessionState.BALL_IN_FLIGHT,
        ball_pos=Vec2("5.000000", "2.000000"),
        ball_vel=Vec2("1.000000", "1.000000"),
    )
    result = step_frame(snap)
    # new_vel.y = 1.0 - GRAVITY = 0.9; new_pos = old_pos + new_vel
    assert result.ball.position.x == fp("6.0")
    assert result.ball.position.y == fp(fp("2.0") + (fp("1.0") - GRAVITY))


def test_ball_in_flight_gravity_accumulates_over_frames():
    snap = _make_snap(
        possession=PossessionState.BALL_IN_FLIGHT,
        ball_vel=Vec2("0.000000", "1.000000"),
    )
    for _ in range(5):
        snap = step_frame(snap)
    # After 5 frames: vy = 1.0 - 5*0.1 = 0.5
    assert snap.ball.velocity.y == fp("0.500000")


def test_loose_ball_velocity_decays_by_friction():
    snap = _make_snap(
        possession=PossessionState.LOOSE_BALL,
        ball_vel=Vec2("2.000000", "0.000000"),
    )
    result = step_frame(snap)
    assert result.ball.velocity.x == fp(fp("2.0") * BALL_FRICTION)


def test_loose_ball_velocity_reaches_near_zero_after_many_frames():
    snap = _make_snap(
        possession=PossessionState.LOOSE_BALL,
        ball_vel=Vec2("3.000000", "0.000000"),
    )
    for _ in range(50):
        snap = step_frame(snap)
    # 0.9^50 ≈ 0.00515 → well below 0.1
    assert snap.ball.velocity.x < fp("0.100000")


# ---------------------------------------------------------------------------
# 6. End-to-end sequence
# ---------------------------------------------------------------------------


def test_thirty_frame_run_schema_valid_at_every_step():
    snap = _make_snap(attacker_pos=Vec2("0.0", "0.0"), threat_level="0.400000")
    for _ in range(30):
        snap = step_frame(snap)
        validate_snapshot(snap)


def test_attacker_approaches_basket_over_frames_with_low_threat():
    # Use 4 frames: attacker traces (0,0)→(0.5,0.5)→(1.5,0.5)→(3,0)→(5,0),
    # which is clearly closer to basket (7.5,0) than the starting (0,0).
    start = _make_snap(
        attacker_pos=Vec2("0.000000", "0.000000"),
        threat_level="0.100000",
    )
    snap = start
    for _ in range(4):
        snap = step_frame(snap)
    from engine.defender_transition import BASKET

    def _dist_sq_to_basket(s: GameSnapshot) -> Decimal:
        dx = s.attacker.kinematics.position.x - BASKET.x
        dy = s.attacker.kinematics.position.y - BASKET.y
        return dx * dx + dy * dy

    assert _dist_sq_to_basket(snap) < _dist_sq_to_basket(start)

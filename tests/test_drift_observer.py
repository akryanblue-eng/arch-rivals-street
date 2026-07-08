"""M2 — Drift observer tests: structural guards, zero deltas, exact arithmetic."""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal

import pytest

from engine.drift_observer import DriftObservation, DriftObservationReport, observe_tracks
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
# Shared test fixture
# ---------------------------------------------------------------------------

_ZERO = Vec2("0.000000", "0.000000")
_ZERO_K = Kinematics(position=_ZERO, velocity=_ZERO, acceleration=_ZERO)


def _make_snap(frame: int = 1) -> GameSnapshot:
    return GameSnapshot(
        frame=frame,
        attacker=AttackerState(
            kinematics=Kinematics(
                position=Vec2("1.000000", "1.000000"),
                velocity=Vec2("0.100000", "0.000000"),
                acceleration=_ZERO,
            )
        ),
        defender=DefenderState(
            kinematics=Kinematics(
                position=Vec2("2.000000", "2.000000"),
                velocity=_ZERO,
                acceleration=_ZERO,
            ),
            belief=DefenderBelief(
                predicted_intercept=Vec2("2.000000", "2.000000"),
                threat_level=fp("0.500000"),
                mode=DefenderMode.GUARDING,
            ),
        ),
        ball=BallState(
            possession=PossessionState.ATTACKER,
            position=Vec2("1.000000", "1.000000"),
            velocity=_ZERO,
            launch_angle=fp("0.0"),
            spin=fp("0.0"),
        ),
    )


# ---------------------------------------------------------------------------
# 1. Structural alignment guards
# ---------------------------------------------------------------------------


def test_length_mismatch_raises_value_error():
    snap = _make_snap()
    with pytest.raises(ValueError, match="Track lengths do not match"):
        observe_tracks([snap, snap], [snap])


def test_empty_tracks_raise_no_error():
    report = observe_tracks([], [])
    assert report.frames_compared == 0
    assert report.first_divergence_frame is None
    assert len(report.observations) == 0


def test_frame_id_mismatch_raises_value_error():
    ref = _make_snap(frame=1)
    cand = replace(ref, frame=99)
    with pytest.raises(ValueError, match="Timeline identity mismatch"):
        observe_tracks([ref], [cand])


def test_frame_id_mismatch_includes_both_frame_numbers():
    ref = _make_snap(frame=5)
    cand = replace(ref, frame=10)
    with pytest.raises(ValueError) as exc_info:
        observe_tracks([ref], [cand])
    msg = str(exc_info.value)
    assert "5" in msg
    assert "10" in msg


# ---------------------------------------------------------------------------
# 2. Identical tracks produce zero deltas
# ---------------------------------------------------------------------------


def test_identical_tracks_first_divergence_is_none():
    snap = _make_snap()
    report = observe_tracks([snap], [snap])
    assert report.first_divergence_frame is None


def test_identical_tracks_all_deltas_zero():
    snap = _make_snap()
    report = observe_tracks([snap], [snap])
    obs = report.observations[0]
    assert obs.position_delta_sq == Decimal("0")
    assert obs.velocity_delta_sq == Decimal("0")
    assert obs.ball_delta_sq == Decimal("0")
    assert obs.belief_delta_sq == Decimal("0")
    assert obs.threat_delta == Decimal("0")


def test_identical_multi_frame_track_all_zero():
    track = [_make_snap(frame=i) for i in range(10)]
    report = observe_tracks(track, track)
    assert report.first_divergence_frame is None
    for obs in report.observations:
        assert obs.position_delta_sq == Decimal("0")
        assert obs.threat_delta == Decimal("0")


# ---------------------------------------------------------------------------
# 3. Exact delta computation
# ---------------------------------------------------------------------------


def test_defender_position_shift_computes_correct_position_delta_sq():
    ref = _make_snap()
    # Move defender from (2, 2) to (2.5, 2): dx=0.5, dy=0
    new_kin = replace(ref.defender.kinematics, position=Vec2("2.500000", "2.000000"))
    cand = replace(ref, defender=replace(ref.defender, kinematics=new_kin))

    report = observe_tracks([ref], [cand])
    # (-0.5)^2 + 0^2 (attacker unchanged) + (-0.5)^2 + 0^2 (defender) = 0.25
    assert report.observations[0].position_delta_sq == Decimal("0.25")


def test_threat_level_shift_computes_correct_threat_delta():
    ref = _make_snap()
    new_belief = replace(ref.defender.belief, threat_level=fp("0.800000"))
    cand = replace(ref, defender=replace(ref.defender, belief=new_belief))

    report = observe_tracks([ref], [cand])
    # |0.5 - 0.8| = 0.3
    assert report.observations[0].threat_delta == Decimal("0.3")


def test_position_and_threat_diverge_simultaneously():
    ref = _make_snap()
    new_kin = replace(ref.defender.kinematics, position=Vec2("2.500000", "2.000000"))
    new_belief = replace(ref.defender.belief, threat_level=fp("0.800000"))
    cand = replace(ref, defender=replace(ref.defender, kinematics=new_kin, belief=new_belief))

    report = observe_tracks([ref], [cand])
    assert report.first_divergence_frame == 1
    assert report.observations[0].position_delta_sq == Decimal("0.25")
    assert report.observations[0].threat_delta == Decimal("0.3")


def test_attacker_velocity_shift_computes_velocity_delta_sq():
    ref = _make_snap()
    new_kin = replace(ref.attacker.kinematics, velocity=Vec2("1.100000", "0.000000"))
    cand = replace(ref, attacker=replace(ref.attacker, kinematics=new_kin))

    report = observe_tracks([ref], [cand])
    # avx diff = 0.1 - 1.1 = -1.0; avy diff = 0; defender unchanged
    assert report.observations[0].velocity_delta_sq == Decimal("1.0")
    assert report.observations[0].position_delta_sq == Decimal("0")


def test_ball_position_shift_computes_ball_delta_sq():
    ref = _make_snap()
    cand = replace(
        ref,
        ball=replace(ref.ball, position=Vec2("2.000000", "1.000000")),
    )
    report = observe_tracks([ref], [cand])
    # bx = 1 - 2 = -1; by = 1 - 1 = 0; delta_sq = 1
    assert report.observations[0].ball_delta_sq == Decimal("1.0")


# ---------------------------------------------------------------------------
# 4. First divergence frame tracking
# ---------------------------------------------------------------------------


def test_first_divergence_frame_is_first_differing_frame():
    ref_track = [_make_snap(frame=i) for i in range(5)]
    cand_track = list(ref_track)  # copy

    # Mutate frame 3 of candidate
    mutated = replace(
        cand_track[3],
        defender=replace(
            cand_track[3].defender,
            kinematics=replace(
                cand_track[3].defender.kinematics,
                position=Vec2("5.000000", "0.000000"),
            ),
        ),
    )
    cand_track[3] = mutated

    report = observe_tracks(ref_track, cand_track)
    assert report.first_divergence_frame == 3


def test_first_divergence_frame_none_when_all_match():
    track = [_make_snap(frame=i) for i in range(20)]
    report = observe_tracks(track, track)
    assert report.first_divergence_frame is None


# ---------------------------------------------------------------------------
# 5. Output structure
# ---------------------------------------------------------------------------


def test_frames_compared_matches_input_length():
    track = [_make_snap(frame=i) for i in range(7)]
    report = observe_tracks(track, track)
    assert report.frames_compared == 7


def test_observations_tuple_length_matches_track():
    track = [_make_snap(frame=i) for i in range(12)]
    report = observe_tracks(track, track)
    assert len(report.observations) == 12


def test_observation_frame_ids_match_input_frames():
    track = [_make_snap(frame=i * 2) for i in range(5)]  # 0, 2, 4, 6, 8
    report = observe_tracks(track, track)
    for obs, snap in zip(report.observations, track):
        assert obs.frame == snap.frame


def test_report_is_immutable():
    snap = _make_snap()
    report = observe_tracks([snap], [snap])
    with pytest.raises((AttributeError, TypeError)):
        report.frames_compared = 999  # type: ignore[misc]

"""M5 — Replay diff: DivergenceDiagnostic channel isolation and zero cases."""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal

import pytest

from engine.frame_stepper import step_frame
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
from engine.replay_diff import DivergenceDiagnostic, compute_replay_diff

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_ZERO_V = Vec2("0.000000", "0.000000")
_ZERO = Decimal("0.000000")


def _make_snap(frame: int = 0) -> GameSnapshot:
    return GameSnapshot(
        frame=frame,
        attacker=AttackerState(
            kinematics=Kinematics(
                position=Vec2("1.000000", "1.000000"),
                velocity=Vec2("0.100000", "0.000000"),
                acceleration=_ZERO_V,
            )
        ),
        defender=DefenderState(
            kinematics=Kinematics(
                position=Vec2("2.000000", "2.000000"),
                velocity=_ZERO_V,
                acceleration=_ZERO_V,
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
            velocity=_ZERO_V,
            launch_angle=fp("0.0"),
            spin=fp("0.0"),
        ),
    )


# ---------------------------------------------------------------------------
# 1. Identical tracks → zero diagnostic
# ---------------------------------------------------------------------------


def test_identical_single_frame_returns_all_zero():
    snap = _make_snap()
    d = compute_replay_diff([snap], [snap])
    assert d.first_divergence_frame is None
    assert d.position_delta_max == _ZERO
    assert d.velocity_delta_max == _ZERO
    assert d.ball_delta_max == _ZERO
    assert d.belief_delta_max == _ZERO
    assert d.threat_delta_max == _ZERO


def test_identical_multi_frame_returns_all_zero():
    snap = _make_snap()
    track = [snap, step_frame(snap), step_frame(step_frame(snap))]
    # Re-frame so frames match
    track_a = [replace(s, frame=i) for i, s in enumerate(
        [snap, step_frame(snap)]
    )]
    d = compute_replay_diff(track_a, track_a)
    assert d.first_divergence_frame is None
    assert d.ball_delta_max == _ZERO


def test_empty_tracks_returns_zero_diagnostic():
    d = compute_replay_diff([], [])
    assert d.first_divergence_frame is None
    assert d.position_delta_max == _ZERO
    assert d.ball_delta_max == _ZERO


# ---------------------------------------------------------------------------
# 2. Ball-only mutation — correct delta, other channels zero
# ---------------------------------------------------------------------------


def test_ball_position_mutation_isolates_to_ball_channel():
    ref = _make_snap(frame=0)
    # Move ball from (1.0, 1.0) to (4.5, 0.0)
    # ball_delta_sq = (1.0-4.5)^2 + (1.0-0.0)^2 = 12.25 + 1.0 = 13.25
    cand = replace(ref, ball=replace(ref.ball, position=Vec2("4.500000", "0.000000")))
    d = compute_replay_diff([ref], [cand])
    assert d.first_divergence_frame == 0
    assert d.ball_delta_max == Decimal("13.25")
    assert d.position_delta_max == _ZERO
    assert d.velocity_delta_max == _ZERO
    assert d.belief_delta_max == _ZERO
    assert d.threat_delta_max == _ZERO


def test_ball_same_position_different_x_only():
    ref = _make_snap(frame=0)
    # Move ball x by 3.0: (1.0->4.0, y unchanged 1.0)
    # ball_delta_sq = (1.0-4.0)^2 + 0^2 = 9.0
    cand = replace(ref, ball=replace(ref.ball, position=Vec2("4.000000", "1.000000")))
    d = compute_replay_diff([ref], [cand])
    assert d.ball_delta_max == Decimal("9.0")


# ---------------------------------------------------------------------------
# 3. Attacker position mutation — isolates to position channel
# ---------------------------------------------------------------------------


def test_attacker_position_mutation_isolates_to_position_channel():
    ref = _make_snap(frame=0)
    # Move attacker from (1.0, 1.0) to (1.5, 1.0): dx=0.5, dy=0
    # position_delta_sq = (0.5)^2 = 0.25 (attacker only; defender unchanged)
    cand = replace(
        ref,
        attacker=replace(
            ref.attacker,
            kinematics=replace(ref.attacker.kinematics, position=Vec2("1.500000", "1.000000")),
        ),
    )
    d = compute_replay_diff([ref], [cand])
    assert d.position_delta_max == Decimal("0.25")
    assert d.ball_delta_max == _ZERO
    assert d.velocity_delta_max == _ZERO


# ---------------------------------------------------------------------------
# 4. Threat delta mutation — isolates to threat channel
# ---------------------------------------------------------------------------


def test_threat_mutation_isolates_to_threat_channel():
    ref = _make_snap(frame=0)
    # Change threat_level from 0.5 to 0.8: |0.5 - 0.8| = 0.3
    cand = replace(
        ref,
        defender=replace(
            ref.defender,
            belief=replace(ref.defender.belief, threat_level=fp("0.800000")),
        ),
    )
    d = compute_replay_diff([ref], [cand])
    assert d.threat_delta_max == Decimal("0.3")
    assert d.position_delta_max == _ZERO
    assert d.ball_delta_max == _ZERO


# ---------------------------------------------------------------------------
# 5. first_divergence_frame carries through correctly
# ---------------------------------------------------------------------------


def test_first_divergence_frame_matches_first_differing_frame():
    base = _make_snap(frame=0)
    f1 = step_frame(base)
    f2 = step_frame(f1)

    ref_track = [base, f1, f2]
    # Diverge only at frame 2
    f2_tampered = replace(
        f2,
        ball=replace(f2.ball, position=Vec2("9.000000", "0.000000")),
    )
    cand_track = [base, f1, f2_tampered]

    d = compute_replay_diff(ref_track, cand_track)
    assert d.first_divergence_frame == f2.frame
    assert d.ball_delta_max > _ZERO


def test_identical_tracks_first_divergence_frame_is_none():
    snap = _make_snap()
    d = compute_replay_diff([snap], [snap])
    assert d.first_divergence_frame is None


# ---------------------------------------------------------------------------
# 6. DivergenceDiagnostic is immutable
# ---------------------------------------------------------------------------


def test_divergence_diagnostic_is_frozen():
    snap = _make_snap()
    d = compute_replay_diff([snap], [snap])
    with pytest.raises((AttributeError, TypeError)):
        d.ball_delta_max = Decimal("9999.0")  # type: ignore[misc]


# ---------------------------------------------------------------------------
# 7. Length mismatch propagates from observe_tracks
# ---------------------------------------------------------------------------


def test_length_mismatch_raises_value_error():
    snap = _make_snap()
    with pytest.raises(ValueError, match="Track lengths"):
        compute_replay_diff([snap, snap], [snap])


# ---------------------------------------------------------------------------
# 8. Multi-frame max selection
# ---------------------------------------------------------------------------


def test_max_delta_across_multiple_frames():
    base = _make_snap(frame=0)
    f1 = step_frame(base)

    # Frame 0: ball delta_sq = 0; Frame 1: ball moved far
    f1_tampered = replace(
        f1,
        ball=replace(f1.ball, position=Vec2("10.000000", "0.000000")),
    )
    # f1 real ball position follows attacker in ATTACKER possession
    real_ball_pos = f1.ball.position
    # ball_delta_sq = (real_x - 10.0)^2 + (real_y - 0.0)^2
    dx = real_ball_pos.x - Decimal("10.000000")
    dy = real_ball_pos.y - Decimal("0.000000")
    expected_max = dx * dx + dy * dy

    d = compute_replay_diff([base, f1], [base, f1_tampered])
    assert d.ball_delta_max == expected_max
    # Frame 0 had no divergence, so max was from frame 1
    assert d.first_divergence_frame == f1.frame

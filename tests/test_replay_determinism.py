"""Layer 1: Deterministic replay tests.

Guarantees that step_frame is byte-identical across runs: same seed →
same 1 000-frame JSON hash.  No mutable shared state is allowed to survive
between calls.
"""

from __future__ import annotations

import hashlib
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

# ---------------------------------------------------------------------------
# Seed snapshots
# ---------------------------------------------------------------------------

_ZERO = Vec2("0.000000", "0.000000")
_ZERO_K = Kinematics(position=_ZERO, velocity=_ZERO, acceleration=_ZERO)


def _seed_snap(
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


def _run_n(seed: GameSnapshot, n: int) -> GameSnapshot:
    s = seed
    for _ in range(n):
        s = step_frame(s)
    return s


def _snapshot_hash(s: GameSnapshot) -> str:
    return hashlib.sha256(s.to_json().encode()).hexdigest()


# ---------------------------------------------------------------------------
# 1. Single-step byte equivalence
# ---------------------------------------------------------------------------


def test_same_input_produces_byte_identical_json():
    a = _seed_snap(attacker_pos=Vec2("1.000000", "0.500000"))
    b = _seed_snap(attacker_pos=Vec2("1.000000", "0.500000"))
    assert step_frame(a).to_json() == step_frame(b).to_json()


def test_byte_identical_implies_same_hash():
    a = _seed_snap(attacker_vel=Vec2("0.500000", "0.250000"))
    b = _seed_snap(attacker_vel=Vec2("0.500000", "0.250000"))
    assert _snapshot_hash(step_frame(a)) == _snapshot_hash(step_frame(b))


def test_different_seeds_produce_different_hashes():
    a = _seed_snap(attacker_pos=Vec2("1.000000", "0.000000"))
    b = _seed_snap(attacker_pos=Vec2("2.000000", "0.000000"))
    assert _snapshot_hash(step_frame(a)) != _snapshot_hash(step_frame(b))


# ---------------------------------------------------------------------------
# 2. 1 000-frame hash stability
# ---------------------------------------------------------------------------


def test_thousand_frame_replay_hash_is_stable():
    """Two independent 1 000-frame runs from the same seed must hash identically."""
    seed = _seed_snap(
        attacker_pos=Vec2("0.000000", "0.000000"),
        attacker_vel=Vec2("0.500000", "0.000000"),
        defender_pos=Vec2("5.000000", "0.000000"),
        defender_vel=Vec2("-0.200000", "0.000000"),
        threat_level="0.350000",
    )
    h1 = _snapshot_hash(_run_n(seed, 1000))
    h2 = _snapshot_hash(_run_n(seed, 1000))
    assert h1 == h2


def test_thousand_frame_replay_frame_number_is_1000():
    seed = _seed_snap()
    result = _run_n(seed, 1000)
    assert result.frame == 1000


def test_thousand_frame_replay_from_nonzero_start():
    seed = _seed_snap(frame=500, threat_level="0.600000")
    h1 = _snapshot_hash(_run_n(seed, 1000))
    h2 = _snapshot_hash(_run_n(seed, 1000))
    assert h1 == h2


@pytest.mark.parametrize("n", [1, 10, 100, 500, 1000])
def test_n_frame_replay_is_deterministic(n: int):
    seed = _seed_snap(
        attacker_pos=Vec2("2.000000", "1.000000"),
        threat_level="0.450000",
    )
    assert _snapshot_hash(_run_n(seed, n)) == _snapshot_hash(_run_n(seed, n))


# ---------------------------------------------------------------------------
# 3. No mutation of original snapshot
# ---------------------------------------------------------------------------


def test_step_frame_does_not_mutate_frame_field():
    seed = _seed_snap(frame=42)
    _ = _run_n(seed, 100)
    assert seed.frame == 42


def test_step_frame_does_not_mutate_attacker_position():
    pos = Vec2("3.000000", "1.500000")
    seed = _seed_snap(attacker_pos=pos)
    _ = _run_n(seed, 100)
    assert seed.attacker.kinematics.position == pos


def test_step_frame_does_not_mutate_ball_possession():
    seed = _seed_snap(possession=PossessionState.BALL_IN_FLIGHT)
    _ = _run_n(seed, 50)
    assert seed.ball.possession == PossessionState.BALL_IN_FLIGHT


def test_step_frame_does_not_mutate_defender_belief():
    seed = _seed_snap(threat_level="0.800000")
    original_threat = seed.defender.belief.threat_level
    _ = _run_n(seed, 100)
    assert seed.defender.belief.threat_level == original_threat


# ---------------------------------------------------------------------------
# 4. Frame counter advances exactly once per step_frame call
# ---------------------------------------------------------------------------


def test_frame_increments_by_one_per_step():
    s = _seed_snap(frame=0)
    for expected in range(1, 21):
        s = step_frame(s)
        assert s.frame == expected


def test_frame_counter_never_skips_or_doubles():
    s = _seed_snap(frame=0)
    prev = s.frame
    for _ in range(200):
        s = step_frame(s)
        assert s.frame == prev + 1
        prev = s.frame


# ---------------------------------------------------------------------------
# 5. Decimal quantization stability
# ---------------------------------------------------------------------------


def test_decimal_quantization_survives_round_trip():
    """JSON round-trip must not alter fixed-point values."""
    seed = _seed_snap(
        attacker_pos=Vec2("3.141593", "2.718282"),
        attacker_vel=Vec2("0.333333", "0.666667"),
    )
    result = step_frame(seed)
    restored = GameSnapshot.from_json(result.to_json())
    assert restored == result


def test_decimal_precision_stable_over_1000_frames():
    """No accumulated floating-point drift: all Decimal values must still
    carry exactly 6 decimal places after 1 000 frames."""
    result = _run_n(_seed_snap(), 1000)
    pos = result.attacker.kinematics.position
    # fp() quantizes to 6 places; sign(str(x)) of a valid fp Decimal ends in 6-digit mantissa
    for coord in (pos.x, pos.y):
        s = format(coord, "f")
        _, _, frac = s.partition(".")
        assert len(frac) == 6, f"precision lost: {coord!r}"


def test_json_serialization_produces_fixed_point_strings():
    """All numeric fields in the JSON must be quoted 6-decimal strings,
    never bare integers or floats."""
    import json
    result = step_frame(_seed_snap())
    doc = json.loads(result.to_json())
    attacker_pos = doc["attacker"]["kinematics"]["position"]
    for key in ("x", "y"):
        val = attacker_pos[key]
        assert isinstance(val, str), f"expected str, got {type(val).__name__}: {val!r}"
        assert "." in val


def test_to_json_is_deterministic_across_calls():
    result = step_frame(_seed_snap(attacker_pos=Vec2("5.000000", "2.000000")))
    assert result.to_json() == result.to_json()


def test_json_sort_keys_canonical():
    """to_json() must produce sorted keys for byte-identical output regardless
    of insertion order (CPython dict ordering must not be trusted)."""
    import json
    result = step_frame(_seed_snap())
    doc = json.loads(result.to_json())
    raw_keys = list(doc.keys())
    assert raw_keys == sorted(raw_keys)

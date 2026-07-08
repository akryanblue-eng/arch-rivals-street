import json
from decimal import Decimal

import jsonschema
import pytest

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
# Fixtures / helpers
# ---------------------------------------------------------------------------

_ZERO = Vec2(0, 0)
_ZERO_K = Kinematics(position=_ZERO, velocity=_ZERO, acceleration=_ZERO)


def make_snapshot(
    frame: int = 0,
    possession: PossessionState = PossessionState.ATTACKER,
    threat_level=0.5,
    mode: DefenderMode = DefenderMode.GUARDING,
    spin="0.0",
    launch_angle="0.0",
) -> GameSnapshot:
    belief = DefenderBelief(
        predicted_intercept=_ZERO,
        threat_level=fp(threat_level),
        mode=mode,
    )
    return GameSnapshot(
        frame=frame,
        attacker=AttackerState(kinematics=_ZERO_K),
        defender=DefenderState(kinematics=_ZERO_K, belief=belief),
        ball=BallState(
            possession=possession,
            position=_ZERO,
            velocity=_ZERO,
            launch_angle=fp(launch_angle),
            spin=fp(spin),
        ),
    )


# ---------------------------------------------------------------------------
# Fixed-point primitive tests
# ---------------------------------------------------------------------------


def test_fp_quantizes_to_six_decimal_places():
    assert str(fp("1.23456789")) == "1.234568"  # rounds last digit up
    assert str(fp("1.0")) == "1.000000"
    assert str(fp(0)) == "0.000000"
    assert str(fp("-0.5")) == "-0.500000"


def test_vec2_normalises_float_and_string_inputs_identically():
    from_str = Vec2("1.5", "2.25")
    from_float = Vec2(1.5, 2.25)
    from_decimal = Vec2(Decimal("1.5"), Decimal("2.25"))
    assert from_str == from_float == from_decimal


def test_vec2_repr_is_six_place_fixed_point_strings():
    d = Vec2("3.14159265", "-2.71828182").to_dict()
    assert d == {"x": "3.141593", "y": "-2.718282"}


def test_fixed_point_addition_is_exact_not_float_accumulated():
    # Summing 0.1 ten times in IEEE-754 floats != 1.0 exactly.
    # The fixed-point representation must not leak that drift.
    total = sum(fp("0.1") for _ in range(10))
    assert total == fp("1.0")
    assert str(total.quantize(Decimal("0.000001"))) == "1.000000"


# ---------------------------------------------------------------------------
# Round-trip serialization
# ---------------------------------------------------------------------------


def test_snapshot_dict_round_trip_is_exact():
    s = make_snapshot(frame=42, possession=PossessionState.BALL_IN_FLIGHT, threat_level="0.75")
    assert GameSnapshot.from_dict(s.to_dict()).to_dict() == s.to_dict()


def test_snapshot_json_round_trip_produces_identical_bytes():
    s = make_snapshot(frame=7)
    assert GameSnapshot.from_json(s.to_json()).to_json() == s.to_json()


def test_two_equivalent_snapshots_produce_identical_json():
    # One snapshot built with string inputs, one with float inputs.
    s_str = make_snapshot(threat_level="0.500000", spin="0.0", launch_angle="0.0")
    s_float = make_snapshot(threat_level=0.5, spin=0.0, launch_angle=0.0)
    assert s_str.to_json() == s_float.to_json()


def test_json_output_is_sorted_keys():
    raw = make_snapshot().to_json()
    parsed = json.loads(raw)
    # Top-level keys must appear in lexicographic order.
    keys = list(parsed.keys())
    assert keys == sorted(keys)


# ---------------------------------------------------------------------------
# Schema validation (structural contract)
# ---------------------------------------------------------------------------


def test_validate_snapshot_passes_for_valid_snapshot():
    validate_snapshot(make_snapshot())  # must not raise


def test_schema_rejects_native_float_for_fixed_point_field():
    s = make_snapshot()
    bad = s.to_dict()
    bad["ball"]["spin"] = 0.0  # float instead of "0.000000" string
    schema = json.loads(
        (
            __import__("pathlib").Path(__file__).parent.parent
            / "engine/schemas/game_state.schema.json"
        ).read_text()
    )
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=bad, schema=schema)


def test_schema_rejects_negative_frame():
    s = make_snapshot()
    bad = s.to_dict()
    bad["frame"] = -1
    from engine.game_state import GAME_STATE_SCHEMA_PATH
    schema = json.loads(GAME_STATE_SCHEMA_PATH.read_text())
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=bad, schema=schema)


def test_schema_rejects_unknown_possession_state():
    s = make_snapshot()
    bad = s.to_dict()
    bad["ball"]["possession"] = "MAYBE"
    from engine.game_state import GAME_STATE_SCHEMA_PATH
    schema = json.loads(GAME_STATE_SCHEMA_PATH.read_text())
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=bad, schema=schema)


def test_schema_rejects_unknown_defender_mode():
    s = make_snapshot()
    bad = s.to_dict()
    bad["defender"]["belief"]["mode"] = "FLOPPING"
    from engine.game_state import GAME_STATE_SCHEMA_PATH
    schema = json.loads(GAME_STATE_SCHEMA_PATH.read_text())
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=bad, schema=schema)


# ---------------------------------------------------------------------------
# Domain invariant tests
# ---------------------------------------------------------------------------


def test_threat_level_above_one_fails_domain_invariant():
    with pytest.raises(ValueError, match="threat_level"):
        validate_snapshot(make_snapshot(threat_level="1.5"))


def test_threat_level_below_zero_fails_domain_invariant():
    with pytest.raises(ValueError, match="threat_level"):
        validate_snapshot(make_snapshot(threat_level="-0.1"))


def test_spin_above_one_fails_domain_invariant():
    with pytest.raises(ValueError, match="spin"):
        validate_snapshot(make_snapshot(spin="1.000001"))


def test_spin_below_minus_one_fails_domain_invariant():
    with pytest.raises(ValueError, match="spin"):
        validate_snapshot(make_snapshot(spin="-1.000001"))


def test_boundary_threat_levels_are_valid():
    validate_snapshot(make_snapshot(threat_level="0.0"))
    validate_snapshot(make_snapshot(threat_level="1.0"))


def test_boundary_spin_values_are_valid():
    validate_snapshot(make_snapshot(spin="-1.0"))
    validate_snapshot(make_snapshot(spin="1.0"))


# ---------------------------------------------------------------------------
# Enum exhaustiveness
# ---------------------------------------------------------------------------


def test_all_possession_states_survive_round_trip():
    for state in PossessionState:
        s = make_snapshot(possession=state)
        assert GameSnapshot.from_dict(s.to_dict()).ball.possession == state


def test_all_defender_modes_survive_round_trip():
    for mode in DefenderMode:
        s = make_snapshot(mode=mode)
        assert GameSnapshot.from_dict(s.to_dict()).defender.belief.mode == mode

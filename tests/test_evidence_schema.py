"""M4 Part 2 — Evidence schema: EvidenceRecord structure, canonical bytes,
JSON encoding contract."""

from __future__ import annotations

import json
from decimal import Decimal

import pytest

from engine.drift_observer import DriftObservation, DriftObservationReport
from engine.drift_policy import DriftVerdict
from engine.evidence_schema import EvidenceRecord, EvidenceEncoder


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_ZERO = Decimal("0.000000")


def _make_report(frames: int = 1, divergence_frame: int | None = None) -> DriftObservationReport:
    obs = DriftObservation(
        frame=1,
        position_delta_sq=_ZERO,
        velocity_delta_sq=_ZERO,
        ball_delta_sq=_ZERO,
        belief_delta_sq=_ZERO,
        threat_delta=_ZERO,
    )
    return DriftObservationReport(
        frames_compared=frames,
        first_divergence_frame=divergence_frame,
        observations=[obs] * frames,
    )


def _make_verdict(classification: str = "IDENTICAL_TRACKS") -> DriftVerdict:
    actions = {
        "IDENTICAL_TRACKS": ("NONE", "CONTINUE"),
        "SOFT_DESYNC_RECOVERABLE": ("WARNING", "REPLAY_FROM_CHECKPOINT"),
        "BELIEF_STATE_DIVERGENCE": ("CRITICAL", "FLAG_FOR_REVIEW"),
        "KINEMATIC_DIVERGENCE": ("FATAL", "INVALIDATE_RUN"),
    }
    severity, action = actions[classification]
    return DriftVerdict(
        classification=classification,
        severity=severity,
        action=action,
        composite_score=_ZERO,
    )


def _make_record(
    run_id: str = "run-abc-001",
    engine_version: str = "0.1.0",
    frames_run: int = 1,
    timestamp: str = "2026-07-08T00:00:00Z",
    classification: str = "IDENTICAL_TRACKS",
) -> EvidenceRecord:
    return EvidenceRecord(
        run_id=run_id,
        engine_version=engine_version,
        frames_run=frames_run,
        timestamp=timestamp,
        observer_report=_make_report(frames_run),
        policy_verdict=_make_verdict(classification),
    )


# ---------------------------------------------------------------------------
# 1. EvidenceRecord is immutable
# ---------------------------------------------------------------------------


def test_evidence_record_is_frozen():
    rec = _make_record()
    with pytest.raises((AttributeError, TypeError)):
        rec.run_id = "tampered"  # type: ignore[misc]


def test_evidence_record_stores_all_required_fields():
    rec = _make_record(
        run_id="r1", engine_version="1.2.3", frames_run=10, timestamp="2026-01-01T00:00:00Z"
    )
    assert rec.run_id == "r1"
    assert rec.engine_version == "1.2.3"
    assert rec.frames_run == 10
    assert rec.timestamp == "2026-01-01T00:00:00Z"
    assert isinstance(rec.observer_report, DriftObservationReport)
    assert isinstance(rec.policy_verdict, DriftVerdict)


# ---------------------------------------------------------------------------
# 2. to_canonical_dict — key presence and structure
# ---------------------------------------------------------------------------


def test_canonical_dict_has_all_top_level_keys():
    d = _make_record().to_canonical_dict()
    required = {"run_id", "engine_version", "frames_run", "timestamp",
                "observer_report", "policy_verdict"}
    assert required == set(d.keys())


def test_canonical_dict_observer_report_has_required_keys():
    d = _make_record().to_canonical_dict()
    report_d = d["observer_report"]
    assert set(report_d.keys()) == {"frames_compared", "first_divergence_frame", "observations"}


def test_canonical_dict_policy_verdict_has_required_keys():
    d = _make_record().to_canonical_dict()
    verdict_d = d["policy_verdict"]
    assert set(verdict_d.keys()) == {"classification", "severity", "action", "composite_score"}


def test_canonical_dict_observation_has_all_delta_keys():
    d = _make_record(frames_run=1).to_canonical_dict()
    obs = d["observer_report"]["observations"][0]
    expected = {"frame", "position_delta_sq", "velocity_delta_sq",
                "ball_delta_sq", "belief_delta_sq", "threat_delta"}
    assert expected == set(obs.keys())


def test_canonical_dict_frames_compared_matches_frames_run():
    rec = _make_record(frames_run=5)
    d = rec.to_canonical_dict()
    assert d["observer_report"]["frames_compared"] == 5
    assert len(d["observer_report"]["observations"]) == 5


# ---------------------------------------------------------------------------
# 3. Decimal serialisation — always 6-decimal-place quoted strings
# ---------------------------------------------------------------------------


def test_composite_score_serialised_as_quoted_string():
    d = _make_record().to_canonical_dict()
    composite = d["policy_verdict"]["composite_score"]
    assert isinstance(composite, str)
    assert composite == "0.000000"


def test_delta_fields_serialised_as_quoted_strings():
    d = _make_record().to_canonical_dict()
    obs = d["observer_report"]["observations"][0]
    for key in ("position_delta_sq", "velocity_delta_sq", "ball_delta_sq",
                "belief_delta_sq", "threat_delta"):
        assert isinstance(obs[key], str), f"{key} should be a quoted string"
        assert obs[key] == "0.000000"


def test_non_zero_decimal_serialised_at_six_places():
    report = DriftObservationReport(
        frames_compared=1,
        first_divergence_frame=1,
        observations=[
            DriftObservation(
                frame=1,
                position_delta_sq=Decimal("0.250000"),
                velocity_delta_sq=_ZERO,
                ball_delta_sq=_ZERO,
                belief_delta_sq=_ZERO,
                threat_delta=Decimal("0.300000"),
            )
        ],
    )
    verdict = DriftVerdict(
        classification="SOFT_DESYNC_RECOVERABLE",
        severity="WARNING",
        action="REPLAY_FROM_CHECKPOINT",
        composite_score=Decimal("0.015000"),
    )
    rec = EvidenceRecord(
        run_id="r2",
        engine_version="0.1.0",
        frames_run=1,
        timestamp="2026-07-08T00:00:00Z",
        observer_report=report,
        policy_verdict=verdict,
    )
    d = rec.to_canonical_dict()
    obs = d["observer_report"]["observations"][0]
    assert obs["position_delta_sq"] == "0.250000"
    assert obs["threat_delta"] == "0.300000"
    assert d["policy_verdict"]["composite_score"] == "0.015000"


# ---------------------------------------------------------------------------
# 4. to_canonical_bytes — determinism and JSON validity
# ---------------------------------------------------------------------------


def test_canonical_bytes_is_valid_json():
    rec = _make_record()
    raw = rec.to_canonical_bytes()
    parsed = json.loads(raw)
    assert parsed["run_id"] == rec.run_id


def test_canonical_bytes_is_deterministic():
    rec = _make_record(run_id="det-test")
    b1 = rec.to_canonical_bytes()
    b2 = rec.to_canonical_bytes()
    assert b1 == b2


def test_canonical_bytes_differs_for_different_run_id():
    r1 = _make_record(run_id="run-A")
    r2 = _make_record(run_id="run-B")
    assert r1.to_canonical_bytes() != r2.to_canonical_bytes()


def test_canonical_bytes_differs_for_different_verdict():
    r1 = _make_record(classification="IDENTICAL_TRACKS")
    r2 = _make_record(classification="KINEMATIC_DIVERGENCE")
    assert r1.to_canonical_bytes() != r2.to_canonical_bytes()


def test_canonical_bytes_uses_sorted_keys():
    rec = _make_record()
    raw = rec.to_canonical_bytes().decode("utf-8")
    # Top-level keys must appear in lexicographic order
    positions = {key: raw.index(f'"{key}"') for key in
                 ["engine_version", "frames_run", "observer_report",
                  "policy_verdict", "run_id", "timestamp"]}
    keys_in_order = sorted(positions.keys(), key=lambda k: positions[k])
    assert keys_in_order == sorted(keys_in_order)


def test_canonical_bytes_uses_compact_separators():
    rec = _make_record()
    raw = rec.to_canonical_bytes().decode("utf-8")
    # Compact separators means no ": " or ", " patterns (uses ":" and ",")
    assert ": " not in raw
    assert ", " not in raw


# ---------------------------------------------------------------------------
# 5. EvidenceEncoder — standalone JSON encoder for Decimal
# ---------------------------------------------------------------------------


def test_evidence_encoder_renders_decimal_as_six_place_string():
    payload = {"value": Decimal("3.140000")}
    result = json.dumps(payload, cls=EvidenceEncoder)
    parsed = json.loads(result)
    assert parsed["value"] == "3.140000"


def test_evidence_encoder_passes_non_decimal_through():
    payload = {"a": 1, "b": "text", "c": [1, 2]}
    result = json.dumps(payload, cls=EvidenceEncoder)
    assert json.loads(result) == payload


def test_evidence_encoder_raises_for_unknown_types():
    import pytest

    class Unserializable:
        pass

    with pytest.raises(TypeError):
        json.dumps({"x": Unserializable()}, cls=EvidenceEncoder)


# ---------------------------------------------------------------------------
# 6. first_divergence_frame — None and non-None propagation
# ---------------------------------------------------------------------------


def test_none_divergence_frame_serialised_as_null():
    rec = _make_record()
    d = rec.to_canonical_dict()
    assert d["observer_report"]["first_divergence_frame"] is None


def test_non_none_divergence_frame_preserved():
    report = DriftObservationReport(
        frames_compared=3,
        first_divergence_frame=2,
        observations=[
            DriftObservation(frame=i, position_delta_sq=_ZERO,
                             velocity_delta_sq=_ZERO, ball_delta_sq=_ZERO,
                             belief_delta_sq=_ZERO, threat_delta=_ZERO)
            for i in range(3)
        ],
    )
    rec = EvidenceRecord(
        run_id="r3",
        engine_version="0.1.0",
        frames_run=3,
        timestamp="2026-07-08T00:00:00Z",
        observer_report=report,
        policy_verdict=_make_verdict(),
    )
    d = rec.to_canonical_dict()
    assert d["observer_report"]["first_divergence_frame"] == 2

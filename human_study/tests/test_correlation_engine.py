"""L3.5 — Correlation engine: join correctness, isolation, machine leakage guard."""

import pytest

from human_study.analysis.correlation_engine import build_correlation_matrix
from human_study.schemas.perception_event import PerceptionEvent


@pytest.fixture
def mock_datasets():
    machine_records = {
        "art-001": {"classification": "IDENTICAL_TRACKS", "metrics": {"pos_drift": 0.000}},
        "art-002": {"classification": "KINEMATIC_DIVERGENCE", "metrics": {"pos_drift": 4.120}},
    }
    events = [
        PerceptionEvent(artifact_id="art-001", participant_id="p1", question_id="KP-02",
                        response_value="LATE", response_time_ms=1000),
        PerceptionEvent(artifact_id="art-001", participant_id="p2", question_id="KP-02",
                        response_value="LATE", response_time_ms=1100),
        PerceptionEvent(artifact_id="art-001", participant_id="p3", question_id="KP-02",
                        response_value="APPROPRIATE", response_time_ms=900),
        PerceptionEvent(artifact_id="art-002", participant_id="p1", question_id="KP-02",
                        response_value="APPROPRIATE", response_time_ms=850),
    ]
    return machine_records, events


def test_correct_joining_and_distribution_calculation(mock_datasets):
    machines, events = mock_datasets
    records = build_correlation_matrix("run-pilot-a", machines, events)

    art_001 = next(r for r in records if r.artifact_id == "art-001" and r.question_id == "KP-02")
    assert art_001.study_run_id == "run-pilot-a"
    assert art_001.machine_classification == "IDENTICAL_TRACKS"
    assert art_001.sample_count == 3
    assert abs(art_001.response_distribution["LATE"] - 2 / 3) < 1e-9
    assert abs(art_001.response_distribution["APPROPRIATE"] - 1 / 3) < 1e-9


def test_distributions_sum_to_one(mock_datasets):
    machines, events = mock_datasets
    records = build_correlation_matrix("run-pilot-a", machines, events)
    for record in records:
        total = sum(record.response_distribution.values())
        assert abs(total - 1.0) < 1e-9, f"distribution sums to {total} for {record.artifact_id}"


def test_no_cross_artifact_contamination(mock_datasets):
    machines, events = mock_datasets
    records = build_correlation_matrix("run-pilot-a", machines, events)

    art_001 = next(r for r in records if r.artifact_id == "art-001" and r.question_id == "KP-02")
    art_002 = next(r for r in records if r.artifact_id == "art-002" and r.question_id == "KP-02")

    assert art_001.sample_count == 3
    assert art_002.response_distribution["APPROPRIATE"] == 1.0
    assert "LATE" not in art_002.response_distribution


def test_no_machine_leakage(mock_datasets):
    machines, events = mock_datasets
    records = build_correlation_matrix("run-pilot-a", machines, events)

    forbidden = {"metrics", "artifact_hash", "engine_version", "frames_run"}
    for record in records:
        for key in forbidden:
            assert key not in record.__dict__


def test_artifact_without_machine_record_is_skipped():
    machines = {"art-001": {"classification": "IDENTICAL_TRACKS"}}
    events = [
        PerceptionEvent(artifact_id="art-001", participant_id="p1", question_id="KP-01",
                        response_value="YES", response_time_ms=100),
        PerceptionEvent(artifact_id="art-UNKNOWN", participant_id="p1", question_id="KP-01",
                        response_value="NO", response_time_ms=200),
    ]
    records = build_correlation_matrix("run-x", machines, events)
    artifact_ids = {r.artifact_id for r in records}
    assert "art-UNKNOWN" not in artifact_ids
    assert "art-001" in artifact_ids


def test_study_run_id_is_propagated():
    machines = {"art-001": {"classification": "IDENTICAL_TRACKS"}}
    events = [
        PerceptionEvent(artifact_id="art-001", participant_id="p1", question_id="KP-01",
                        response_value="YES", response_time_ms=100),
    ]
    records = build_correlation_matrix("my-special-run", machines, events)
    assert all(r.study_run_id == "my-special-run" for r in records)


def test_output_is_sorted_by_artifact_then_question():
    machines = {
        "art-b": {"classification": "A"},
        "art-a": {"classification": "B"},
    }
    events = [
        PerceptionEvent(artifact_id="art-b", participant_id="p", question_id="KP-02",
                        response_value="LATE", response_time_ms=100),
        PerceptionEvent(artifact_id="art-a", participant_id="p", question_id="KP-01",
                        response_value="YES", response_time_ms=100),
        PerceptionEvent(artifact_id="art-a", participant_id="p", question_id="AP-01",
                        response_value="DELIBERATE", response_time_ms=100),
    ]
    records = build_correlation_matrix("r", machines, events)
    keys = [(r.artifact_id, r.question_id) for r in records]
    assert keys == sorted(keys)


def test_empty_events_returns_empty_list():
    records = build_correlation_matrix("r", {"art-001": {"classification": "X"}}, [])
    assert records == []


def test_empty_machine_records_returns_empty_list():
    events = [PerceptionEvent(artifact_id="a", participant_id="p", question_id="KP-01",
                               response_value="YES", response_time_ms=100)]
    records = build_correlation_matrix("r", {}, events)
    assert records == []

"""L3.6 — Divergence report generator: aggregation correctness, empty safety, no interpretation."""

import json

import pytest

from human_study.analysis.correlation_schema import CorrelationRecord
from human_study.analysis.divergence_report import generate_divergence_report


@pytest.fixture
def sample_records():
    return [
        CorrelationRecord(
            study_run_id="pilot-a",
            artifact_id="art-001",
            machine_classification="IDENTICAL_TRACKS",
            question_id="KP-02",
            response_distribution={"LATE": 0.70, "APPROPRIATE": 0.30},
            sample_count=10,
        ),
        CorrelationRecord(
            study_run_id="pilot-a",
            artifact_id="art-002",
            machine_classification="KINEMATIC_DIVERGENCE",
            question_id="KP-01",
            response_distribution={"YES": 0.90, "NO": 0.10},
            sample_count=15,
        ),
    ]


def test_deterministic_aggregation(sample_records):
    r1 = generate_divergence_report("pilot-a", sample_records)
    r2 = generate_divergence_report("pilot-a", sample_records)

    d1 = {**r1.to_dict(), "generated_timestamp": "FROZEN"}
    d2 = {**r2.to_dict(), "generated_timestamp": "FROZEN"}
    assert d1 == d2


def test_matrix_summary_counts_are_correct(sample_records):
    report = generate_divergence_report("pilot-a", sample_records)
    assert report.matrix_summary["artifacts_processed"] == 2
    assert report.matrix_summary["total_human_samples"] == 25


def test_empty_study_graceful_protection():
    report = generate_divergence_report("pilot-empty", [])
    assert report.matrix_summary["artifacts_processed"] == 0
    assert report.matrix_summary["total_human_samples"] == 0
    assert report.correlations == []


def test_no_interpretation_leakage(sample_records):
    report = generate_divergence_report("pilot-a", sample_records)
    serialized = json.dumps(report.to_dict())
    forbidden = ["PASS", "FAIL", "BROKEN", "FIX", "BAD AI", "GOOD AI"]
    for word in forbidden:
        assert word not in serialized, f"forbidden word '{word}' found in report"


def test_study_run_id_propagated(sample_records):
    report = generate_divergence_report("QSO-PROJECT-002-PILOT-A", sample_records)
    assert report.study_run_id == "QSO-PROJECT-002-PILOT-A"


def test_report_version_is_1_0_0(sample_records):
    report = generate_divergence_report("r", sample_records)
    assert report.report_version == "1.0.0"


def test_correlations_sorted_by_artifact_then_question():
    records = [
        CorrelationRecord("r", "art-b", "X", "KP-02", {"LATE": 1.0}, 1),
        CorrelationRecord("r", "art-a", "Y", "KP-01", {"YES": 1.0}, 1),
        CorrelationRecord("r", "art-a", "Y", "AP-01", {"DELIBERATE": 1.0}, 1),
    ]
    report = generate_divergence_report("r", records)
    keys = [(c["artifact_id"], c["question_id"]) for c in report.correlations]
    assert keys == sorted(keys)


def test_serialize_report_is_valid_json(sample_records):
    report = generate_divergence_report("r", sample_records)
    parsed = json.loads(report.serialize_report())
    assert "correlations" in parsed
    assert "matrix_summary" in parsed


def test_correlations_contain_expected_keys(sample_records):
    report = generate_divergence_report("r", sample_records)
    required = {"artifact_id", "machine_classification", "question_id",
                "response_distribution", "sample_count"}
    for c in report.correlations:
        assert required.issubset(c.keys())


def test_same_artifact_two_questions_aggregated_separately():
    records = [
        CorrelationRecord("r", "art-001", "IDENTICAL_TRACKS", "KP-01", {"YES": 1.0}, 5),
        CorrelationRecord("r", "art-001", "IDENTICAL_TRACKS", "KP-02", {"LATE": 1.0}, 7),
    ]
    report = generate_divergence_report("r", records)
    assert len(report.correlations) == 2
    assert report.matrix_summary["artifacts_processed"] == 1
    assert report.matrix_summary["total_human_samples"] == 12

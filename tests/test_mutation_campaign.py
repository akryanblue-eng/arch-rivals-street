"""Mutation campaign: verifier calibration across 50 controlled perturbations."""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from pathlib import Path

import pytest

from engine.analysis.mutation_campaign import (
    CampaignReport,
    MutationResult,
    run_mutation_campaign,
    write_campaign_archive,
)
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
from engine.replay_artifact import write_replay_bundle
from engine.replay_verifier import VerificationResult, verify_replay_run

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

_ENGINE_VERSION = "1.0.0"
_ZERO_V = Vec2("0.000000", "0.000000")


def _make_seed() -> GameSnapshot:
    return GameSnapshot(
        frame=0,
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


def _build_pristine_bundle(root: Path, n_frames: int = 5) -> Path:
    seed = _make_seed()
    track = [seed]
    state = seed
    for _ in range(n_frames - 1):
        state = step_frame(state)
        track.append(state)
    paths = write_replay_bundle(
        run_id="pristine-campaign",
        engine_version=_ENGINE_VERSION,
        timestamp="2026-07-19T00:00:00Z",
        seed_snapshot=seed,
        truth_track=track,
        artifact_root=root,
    )
    return paths.run_dir


# ---------------------------------------------------------------------------
# 1. Pristine bundle sanity
# ---------------------------------------------------------------------------


def test_pristine_bundle_verifies_cleanly(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    assert verify_replay_run(pristine, _ENGINE_VERSION) == VerificationResult.VERIFIED


# ---------------------------------------------------------------------------
# 2. Campaign structure
# ---------------------------------------------------------------------------


def test_campaign_runs_50_mutations(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    assert report.mutation_count == 50
    assert len(report.results) == 50


def test_campaign_results_tuple_matches_mutation_count(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    assert len(report.results) == report.mutation_count


def test_campaign_has_all_five_taxonomy_classes(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    classes = {r.taxonomy_class for r in report.results}
    assert classes == {"INTEGRITY", "TEMPORAL", "NUMERICAL", "SEMANTIC", "ENVIRONMENT"}


def test_campaign_10_mutations_per_class(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    counts = Counter(r.taxonomy_class for r in report.results)
    for tc in ("INTEGRITY", "TEMPORAL", "NUMERICAL", "SEMANTIC", "ENVIRONMENT"):
        assert counts[tc] == 10, f"Expected 10 mutations for {tc}, got {counts[tc]}"


def test_campaign_results_ordered_by_taxonomy_class(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    classes = [r.taxonomy_class for r in report.results]
    assert classes[:10] == ["INTEGRITY"] * 10
    assert classes[10:20] == ["TEMPORAL"] * 10
    assert classes[20:30] == ["NUMERICAL"] * 10
    assert classes[30:40] == ["SEMANTIC"] * 10
    assert classes[40:50] == ["ENVIRONMENT"] * 10


# ---------------------------------------------------------------------------
# 3. Detection rate — all 50 mutations must be caught
# ---------------------------------------------------------------------------


def test_campaign_all_mutations_detected(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    assert report.detected_count == 50
    assert report.detection_rate == 1.0


def test_campaign_no_false_negatives(tmp_path):
    """Every individual mutation must have detected=True."""
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    undetected = [r for r in report.results if not r.detected]
    assert undetected == [], f"Undetected mutations: {[r.mutation_id for r in undetected]}"


# ---------------------------------------------------------------------------
# 4. Classification accuracy — each mutation returns the expected code
# ---------------------------------------------------------------------------


def test_campaign_classification_accuracy(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    assert report.correct_code_count == 50
    assert report.classification_accuracy == 1.0


def test_campaign_no_misclassifications(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    wrong = [r for r in report.results if not r.correct_code]
    assert wrong == [], (
        f"Misclassified: {[(r.mutation_id, r.expected_result, r.observed_result) for r in wrong]}"
    )


# ---------------------------------------------------------------------------
# 5. INTEGRITY class — cryptographic layer
# ---------------------------------------------------------------------------


def test_integrity_class_all_detected(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    integrity = [r for r in report.results if r.taxonomy_class == "INTEGRITY"]
    assert all(r.detected for r in integrity)


def test_integrity_class_hash_and_seed_failures(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    integrity = [r for r in report.results if r.taxonomy_class == "INTEGRITY"]
    hash_failures = [r for r in integrity if r.observed_result == VerificationResult.HASH_FAILURE]
    seed_mismatches = [r for r in integrity if r.observed_result == VerificationResult.SEED_MISMATCH]
    assert len(hash_failures) == 7
    assert len(seed_mismatches) == 3


# ---------------------------------------------------------------------------
# 6. TEMPORAL class — frame alignment layer
# ---------------------------------------------------------------------------


def test_temporal_class_all_frame_alignment_failure(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    temporal = [r for r in report.results if r.taxonomy_class == "TEMPORAL"]
    assert all(r.observed_result == VerificationResult.FRAME_ALIGNMENT_FAILURE for r in temporal)


# ---------------------------------------------------------------------------
# 7. NUMERICAL class — engine replay layer (kinematic coordinates)
# ---------------------------------------------------------------------------


def test_numerical_class_all_replay_diverged(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    numerical = [r for r in report.results if r.taxonomy_class == "NUMERICAL"]
    assert all(r.observed_result == VerificationResult.REPLAY_DIVERGED for r in numerical)


# ---------------------------------------------------------------------------
# 8. SEMANTIC class — engine replay layer (belief state)
# ---------------------------------------------------------------------------


def test_semantic_class_all_replay_diverged(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    semantic = [r for r in report.results if r.taxonomy_class == "SEMANTIC"]
    assert all(r.observed_result == VerificationResult.REPLAY_DIVERGED for r in semantic)


# ---------------------------------------------------------------------------
# 9. ENVIRONMENT class — governance / metadata layer
# ---------------------------------------------------------------------------


def test_environment_class_all_detected(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    env = [r for r in report.results if r.taxonomy_class == "ENVIRONMENT"]
    assert all(r.detected for r in env)


def test_environment_class_expected_result_codes(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    env = {r.mutation_id: r for r in report.results if r.taxonomy_class == "ENVIRONMENT"}
    version_failures = [r for r in env.values()
                        if r.observed_result == VerificationResult.ENGINE_VERSION_FAILURE]
    seed_mismatches = [r for r in env.values()
                       if r.observed_result == VerificationResult.SEED_MISMATCH]
    hash_failures = [r for r in env.values()
                     if r.observed_result == VerificationResult.HASH_FAILURE]
    invalid_artifacts = [r for r in env.values()
                         if r.observed_result == VerificationResult.INVALID_ARTIFACT]
    assert len(version_failures) == 6  # ENV-01..04, 06, 10
    assert len(seed_mismatches) == 2   # ENV-07, 09
    assert len(hash_failures) == 1     # ENV-08
    assert len(invalid_artifacts) == 1  # ENV-05


# ---------------------------------------------------------------------------
# 10. Source bundle hash
# ---------------------------------------------------------------------------


def test_source_bundle_hash_matches_pristine_truth_track(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    expected = hashlib.sha256((pristine / "truth_track.json").read_bytes()).hexdigest()
    assert report.source_bundle_hash == expected


# ---------------------------------------------------------------------------
# 11. Immutability
# ---------------------------------------------------------------------------


def test_mutation_result_is_frozen(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    r = report.results[0]
    with pytest.raises((AttributeError, TypeError)):
        r.detected = False  # type: ignore[misc]


def test_campaign_report_is_frozen(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    with pytest.raises((AttributeError, TypeError)):
        report.detection_rate = 0.0  # type: ignore[misc]


def test_campaign_results_tuple_is_immutable(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    with pytest.raises((AttributeError, TypeError)):
        report.results = ()  # type: ignore[misc]


# ---------------------------------------------------------------------------
# 12. Archive
# ---------------------------------------------------------------------------


def test_write_campaign_archive_creates_three_files(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    archive_dir = tmp_path / "archive"
    write_campaign_archive(report, archive_dir)
    assert (archive_dir / "campaign_metadata.json").exists()
    assert (archive_dir / "results.json").exists()
    assert (archive_dir / "diagnostics.json").exists()


def test_archive_metadata_reflects_report(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    archive_dir = tmp_path / "archive"
    write_campaign_archive(report, archive_dir)
    meta = json.loads((archive_dir / "campaign_metadata.json").read_text(encoding="utf-8"))
    assert meta["mutation_count"] == 50
    assert meta["detected_count"] == 50
    assert meta["detection_rate"] == 1.0
    assert meta["classification_accuracy"] == 1.0
    assert meta["engine_version"] == _ENGINE_VERSION


def test_archive_results_count_matches_mutations(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    archive_dir = tmp_path / "archive"
    write_campaign_archive(report, archive_dir)
    results = json.loads((archive_dir / "results.json").read_text(encoding="utf-8"))
    assert len(results) == 50


def test_archive_diagnostics_has_five_classes(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    archive_dir = tmp_path / "archive"
    write_campaign_archive(report, archive_dir)
    diag = json.loads((archive_dir / "diagnostics.json").read_text(encoding="utf-8"))
    assert set(diag.keys()) == {
        "INTEGRITY", "TEMPORAL", "NUMERICAL", "SEMANTIC", "ENVIRONMENT"
    }


def test_archive_diagnostics_detection_rates(tmp_path):
    pristine = _build_pristine_bundle(tmp_path / "pristine")
    report = run_mutation_campaign(
        pristine, tmp_path / "campaign", _ENGINE_VERSION, "2026-07-19T00:00:00Z"
    )
    archive_dir = tmp_path / "archive"
    write_campaign_archive(report, archive_dir)
    diag = json.loads((archive_dir / "diagnostics.json").read_text(encoding="utf-8"))
    for tc in ("INTEGRITY", "TEMPORAL", "NUMERICAL", "SEMANTIC", "ENVIRONMENT"):
        assert diag[tc]["detection_rate"] == 1.0, f"{tc} detection_rate != 1.0"
        assert diag[tc]["classification_accuracy"] == 1.0, f"{tc} classification_accuracy != 1.0"
        assert diag[tc]["count"] == 10

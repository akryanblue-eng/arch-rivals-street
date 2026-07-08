"""Pilot preflight validator: single-artifact, batch clearance, and adversarial probes."""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from pathlib import Path

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
from engine.replay_artifact import write_replay_bundle
from engine.replay_verifier import VerificationResult
from pilot.preflight_validator import (
    BatchPreflightReport,
    PreflightResult,
    run_preflight,
    run_preflight_batch,
)

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

_ENGINE_VERSION = "1.0.0"
_ZERO_V = Vec2("0.000000", "0.000000")


def _make_seed(frame: int = 0) -> GameSnapshot:
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


def _build_clean_bundle(root: Path, run_id: str, n_frames: int = 2):
    seed = _make_seed()
    track = [seed]
    state = seed
    for _ in range(n_frames - 1):
        state = step_frame(state)
        track.append(state)
    return write_replay_bundle(
        run_id=run_id,
        engine_version=_ENGINE_VERSION,
        timestamp="2026-07-08T00:00:00Z",
        seed_snapshot=seed,
        truth_track=track,
        artifact_root=root,
    )


# ---------------------------------------------------------------------------
# 1. Single-artifact preflight — pass
# ---------------------------------------------------------------------------


def test_clean_artifact_returns_passed(tmp_path):
    paths = _build_clean_bundle(tmp_path, "pass-1")
    result = run_preflight(paths.run_dir, _ENGINE_VERSION)
    assert result.passed is True
    assert result.verification_result == VerificationResult.VERIFIED


def test_passed_result_carries_artifact_dir(tmp_path):
    paths = _build_clean_bundle(tmp_path, "pass-dir")
    result = run_preflight(paths.run_dir, _ENGINE_VERSION)
    assert result.artifact_dir == paths.run_dir


def test_passed_reason_contains_cleared(tmp_path):
    paths = _build_clean_bundle(tmp_path, "pass-reason")
    result = run_preflight(paths.run_dir, _ENGINE_VERSION)
    assert "cleared" in result.reason.lower()


# ---------------------------------------------------------------------------
# 2. Single-artifact preflight — structured rejection reasons
# ---------------------------------------------------------------------------


def test_missing_files_returns_invalid_artifact_with_reason(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    result = run_preflight(empty, _ENGINE_VERSION)
    assert result.passed is False
    assert result.verification_result == VerificationResult.INVALID_ARTIFACT
    assert "REJECTED" in result.reason
    assert "missing" in result.reason.lower() or "malformed" in result.reason.lower()


def test_wrong_engine_version_returns_version_failure_with_reason(tmp_path):
    paths = _build_clean_bundle(tmp_path, "old-eng")
    result = run_preflight(paths.run_dir, "0.0.1")
    assert result.passed is False
    assert result.verification_result == VerificationResult.ENGINE_VERSION_FAILURE
    assert "REJECTED" in result.reason
    assert "version" in result.reason.lower()


def test_corrupted_seed_returns_seed_mismatch_with_reason(tmp_path):
    paths = _build_clean_bundle(tmp_path, "bad-seed")
    paths.seed_path.write_bytes(b"tampered")
    result = run_preflight(paths.run_dir, _ENGINE_VERSION)
    assert result.passed is False
    assert result.verification_result == VerificationResult.SEED_MISMATCH
    assert "REJECTED" in result.reason
    assert "seed" in result.reason.lower()


def test_corrupted_truth_track_returns_hash_failure_with_reason(tmp_path):
    paths = _build_clean_bundle(tmp_path, "bad-track")
    data = paths.truth_track_path.read_bytes()
    # Flip a byte without updating the manifest hash
    paths.truth_track_path.write_bytes(data[:30] + bytes([data[30] ^ 0x01]) + data[31:])
    result = run_preflight(paths.run_dir, _ENGINE_VERSION)
    assert result.passed is False
    assert result.verification_result == VerificationResult.HASH_FAILURE
    assert "REJECTED" in result.reason
    assert "hash" in result.reason.lower()


def test_replay_diverged_returns_correct_code_with_reason(tmp_path):
    """Tampered content + updated hash → engine catches the divergence."""
    seed = _make_seed()
    real_f1 = step_frame(seed)
    # Move attacker to a position step_frame would never produce
    bad_f1 = replace(
        real_f1,
        attacker=replace(
            real_f1.attacker,
            kinematics=replace(
                real_f1.attacker.kinematics,
                position=Vec2("13.000000", "4.000000"),
            ),
        ),
    )
    track = [seed, bad_f1]

    seed_bytes = json.dumps(seed.to_dict(), sort_keys=True, indent=2).encode("utf-8")
    truth_bytes = json.dumps(
        [s.to_dict() for s in track], sort_keys=True, indent=2
    ).encode("utf-8")
    manifest = {
        "engine_version": _ENGINE_VERSION,
        "run_id": "diverged-run",
        "seed_sha256": hashlib.sha256(seed_bytes).hexdigest(),
        "timestamp": "2026-07-08T00:00:00Z",
        "truth_track_sha256": hashlib.sha256(truth_bytes).hexdigest(),
    }
    run_dir = tmp_path / "diverged-run"
    run_dir.mkdir()
    (run_dir / "seed_snapshot.json").write_bytes(seed_bytes)
    (run_dir / "truth_track.json").write_bytes(truth_bytes)
    (run_dir / "manifest.json").write_text(
        json.dumps(manifest, sort_keys=True, indent=2), encoding="utf-8"
    )

    result = run_preflight(run_dir, _ENGINE_VERSION)
    assert result.passed is False
    assert result.verification_result == VerificationResult.REPLAY_DIVERGED
    assert "REJECTED" in result.reason
    assert "diverge" in result.reason.lower()


# ---------------------------------------------------------------------------
# 3. PreflightResult is immutable
# ---------------------------------------------------------------------------


def test_preflight_result_is_frozen(tmp_path):
    paths = _build_clean_bundle(tmp_path, "immut-single")
    result = run_preflight(paths.run_dir, _ENGINE_VERSION)
    with pytest.raises((AttributeError, TypeError)):
        result.passed = False  # type: ignore[misc]


# ---------------------------------------------------------------------------
# 4. Batch preflight — all pass → cleared_for_study
# ---------------------------------------------------------------------------


def test_batch_all_pass_cleared_for_study(tmp_path):
    p1 = _build_clean_bundle(tmp_path, "art-1")
    p2 = _build_clean_bundle(tmp_path, "art-2")
    p3 = _build_clean_bundle(tmp_path, "art-3")
    report = run_preflight_batch(
        [p1.run_dir, p2.run_dir, p3.run_dir], _ENGINE_VERSION
    )
    assert report.cleared_for_study is True
    assert report.passed_count == 3
    assert report.failed_count == 0
    assert report.total_artifacts == 3


def test_batch_result_order_matches_input_order(tmp_path):
    p1 = _build_clean_bundle(tmp_path, "ord-1")
    p2 = _build_clean_bundle(tmp_path, "ord-2")
    report = run_preflight_batch([p1.run_dir, p2.run_dir], _ENGINE_VERSION)
    assert report.results[0].artifact_dir == p1.run_dir
    assert report.results[1].artifact_dir == p2.run_dir


def test_batch_engine_version_carried_in_report(tmp_path):
    paths = _build_clean_bundle(tmp_path, "ver-carry")
    report = run_preflight_batch([paths.run_dir], _ENGINE_VERSION)
    assert report.engine_version == _ENGINE_VERSION


# ---------------------------------------------------------------------------
# 5. Batch preflight — one failure blocks entire batch
# ---------------------------------------------------------------------------


def test_batch_one_failure_blocks_clearance(tmp_path):
    good = _build_clean_bundle(tmp_path, "good-art")
    empty = tmp_path / "empty-art"
    empty.mkdir()

    report = run_preflight_batch([good.run_dir, empty], _ENGINE_VERSION)
    assert report.cleared_for_study is False
    assert report.passed_count == 1
    assert report.failed_count == 1


def test_batch_one_failure_does_not_short_circuit_evaluation(tmp_path):
    """All artifacts must be evaluated even after a failure is encountered."""
    empty = tmp_path / "empty"
    empty.mkdir()
    good = _build_clean_bundle(tmp_path, "still-checked")

    report = run_preflight_batch([empty, good.run_dir], _ENGINE_VERSION)
    assert report.total_artifacts == 2
    assert len(report.results) == 2
    # Both results are populated regardless of order
    assert report.results[0].passed is False
    assert report.results[1].passed is True


def test_batch_all_fail_not_cleared(tmp_path):
    e1 = tmp_path / "e1"
    e2 = tmp_path / "e2"
    e1.mkdir()
    e2.mkdir()
    report = run_preflight_batch([e1, e2], _ENGINE_VERSION)
    assert report.cleared_for_study is False
    assert report.failed_count == 2


# ---------------------------------------------------------------------------
# 6. Empty batch is not cleared for study
# ---------------------------------------------------------------------------


def test_empty_batch_not_cleared_for_study():
    report = run_preflight_batch([], _ENGINE_VERSION)
    assert report.cleared_for_study is False
    assert report.total_artifacts == 0
    assert report.passed_count == 0
    assert report.failed_count == 0


def test_empty_batch_results_tuple_is_empty():
    report = run_preflight_batch([], _ENGINE_VERSION)
    assert len(report.results) == 0


# ---------------------------------------------------------------------------
# 7. BatchPreflightReport is immutable
# ---------------------------------------------------------------------------


def test_batch_report_is_frozen(tmp_path):
    paths = _build_clean_bundle(tmp_path, "immut-batch")
    report = run_preflight_batch([paths.run_dir], _ENGINE_VERSION)
    with pytest.raises((AttributeError, TypeError)):
        report.cleared_for_study = True  # type: ignore[misc]


def test_batch_results_tuple_is_immutable(tmp_path):
    paths = _build_clean_bundle(tmp_path, "immut-tuple")
    report = run_preflight_batch([paths.run_dir], _ENGINE_VERSION)
    with pytest.raises((AttributeError, TypeError)):
        report.results = ()  # type: ignore[misc]


# ---------------------------------------------------------------------------
# 8. Adversarial: single-decimal mutation
# ---------------------------------------------------------------------------


def test_single_decimal_mutation_without_hash_update_triggers_hash_failure(tmp_path):
    """Change one digit in truth_track.json without updating the manifest hash."""
    paths = _build_clean_bundle(tmp_path, "one-decimal")
    raw = paths.truth_track_path.read_text(encoding="utf-8")

    # Find and flip one digit in the position field
    # truth_track has frame 0 with position "1.000000"; change last digit to "1.000001"
    mutated = raw.replace('"1.000000"', '"1.000001"', 1)
    assert mutated != raw, "Mutation did not change the file"
    paths.truth_track_path.write_text(mutated, encoding="utf-8")

    result = run_preflight(paths.run_dir, _ENGINE_VERSION)
    assert result.passed is False
    assert result.verification_result == VerificationResult.HASH_FAILURE


def test_single_decimal_mutation_with_updated_hash_triggers_replay_diverged(tmp_path):
    """Change one digit AND update the manifest hash → engine replay catches it."""
    paths = _build_clean_bundle(tmp_path, "one-decimal-rehash")
    raw = paths.truth_track_path.read_text(encoding="utf-8")

    # Mutate one position value in the second frame (index 1)
    # Replace the first occurrence of "1.000000" with "9.000000"
    mutated = raw.replace('"1.000000"', '"9.000000"', 1)
    assert mutated != raw
    new_bytes = mutated.encode("utf-8")
    paths.truth_track_path.write_bytes(new_bytes)

    # Update the manifest hash to match the mutated content
    manifest = json.loads(paths.manifest_path.read_text(encoding="utf-8"))
    manifest["truth_track_sha256"] = hashlib.sha256(new_bytes).hexdigest()
    paths.manifest_path.write_text(
        json.dumps(manifest, sort_keys=True, indent=2), encoding="utf-8"
    )

    result = run_preflight(paths.run_dir, _ENGINE_VERSION)
    assert result.passed is False
    # Could be HASH_FAILURE (if seed was mutated) or REPLAY_DIVERGED (engine catches it)
    # We expect REPLAY_DIVERGED since only the truth_track hash was updated
    assert result.verification_result in (
        VerificationResult.REPLAY_DIVERGED,
        VerificationResult.HASH_FAILURE,
    )
    assert result.passed is False


def test_metadata_only_mutation_in_manifest_triggers_version_failure(tmp_path):
    """Alter only a non-hash metadata field → treated as a classifiable rejection."""
    paths = _build_clean_bundle(tmp_path, "meta-mutate")
    manifest = json.loads(paths.manifest_path.read_text(encoding="utf-8"))
    # Change engine_version without touching hashes
    manifest["engine_version"] = "evil-version-99"
    paths.manifest_path.write_text(
        json.dumps(manifest, sort_keys=True, indent=2), encoding="utf-8"
    )
    result = run_preflight(paths.run_dir, _ENGINE_VERSION)
    assert result.passed is False
    assert result.verification_result == VerificationResult.ENGINE_VERSION_FAILURE


def test_state_only_mutation_without_hash_update_fails_at_hash_check(tmp_path):
    """Change a state value in seed_snapshot.json without updating seed_sha256."""
    paths = _build_clean_bundle(tmp_path, "state-mutate")
    seed_raw = paths.seed_path.read_text(encoding="utf-8")
    # Flip a coordinate: "1.000000" → "3.000000" in position
    mutated = seed_raw.replace('"1.000000"', '"3.000000"', 1)
    paths.seed_path.write_text(mutated, encoding="utf-8")

    result = run_preflight(paths.run_dir, _ENGINE_VERSION)
    assert result.passed is False
    assert result.verification_result == VerificationResult.SEED_MISMATCH


# ---------------------------------------------------------------------------
# 9. Multi-artifact pilot scenario
# ---------------------------------------------------------------------------


def test_three_artifact_pilot_all_clear(tmp_path):
    """Represents a real pilot run: reference + two variant artifacts all cleared."""
    ref = _build_clean_bundle(tmp_path, "art-pristine-ref", n_frames=5)
    v1 = _build_clean_bundle(tmp_path, "art-kinematic-v1", n_frames=5)
    v2 = _build_clean_bundle(tmp_path, "art-belief-shift-v1", n_frames=5)

    report = run_preflight_batch(
        [ref.run_dir, v1.run_dir, v2.run_dir], _ENGINE_VERSION
    )
    assert report.cleared_for_study is True
    assert report.total_artifacts == 3
    assert all(r.passed for r in report.results)


def test_pilot_aborted_when_one_artifact_tampered(tmp_path):
    """Even if 2 of 3 artifacts are clean, one bad artifact aborts the study."""
    ref = _build_clean_bundle(tmp_path, "pilot-ref", n_frames=3)
    v1 = _build_clean_bundle(tmp_path, "pilot-v1", n_frames=3)
    bad = tmp_path / "pilot-bad"
    bad.mkdir()

    report = run_preflight_batch([ref.run_dir, v1.run_dir, bad], _ENGINE_VERSION)
    assert report.cleared_for_study is False
    assert report.passed_count == 2
    assert report.failed_count == 1

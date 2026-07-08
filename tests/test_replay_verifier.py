"""M5 — Replay verifier: cryptographic integrity, engine authority, failure modes."""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from pathlib import Path

import pytest

import engine.frame_stepper as frame_stepper_module
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
_ZERO_K = Kinematics(position=_ZERO_V, velocity=_ZERO_V, acceleration=_ZERO_V)


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


def _build_clean_bundle(root: Path, run_id: str = "clean-run", n_frames: int = 2):
    seed = _make_seed(frame=0)
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
# 1. INVALID_ARTIFACT — missing files
# ---------------------------------------------------------------------------


def test_missing_all_files_returns_invalid_artifact(tmp_path):
    empty_dir = tmp_path / "empty"
    empty_dir.mkdir()
    assert verify_replay_run(empty_dir, _ENGINE_VERSION) == VerificationResult.INVALID_ARTIFACT


def test_missing_seed_file_returns_invalid_artifact(tmp_path):
    paths = _build_clean_bundle(tmp_path, "no-seed")
    paths.seed_path.unlink()
    assert verify_replay_run(paths.run_dir, _ENGINE_VERSION) == VerificationResult.INVALID_ARTIFACT


def test_missing_truth_track_returns_invalid_artifact(tmp_path):
    paths = _build_clean_bundle(tmp_path, "no-track")
    paths.truth_track_path.unlink()
    assert verify_replay_run(paths.run_dir, _ENGINE_VERSION) == VerificationResult.INVALID_ARTIFACT


def test_missing_manifest_returns_invalid_artifact(tmp_path):
    paths = _build_clean_bundle(tmp_path, "no-manifest")
    paths.manifest_path.unlink()
    assert verify_replay_run(paths.run_dir, _ENGINE_VERSION) == VerificationResult.INVALID_ARTIFACT


def test_malformed_manifest_json_returns_invalid_artifact(tmp_path):
    paths = _build_clean_bundle(tmp_path, "bad-manifest")
    paths.manifest_path.write_text("{this is not json", encoding="utf-8")
    assert verify_replay_run(paths.run_dir, _ENGINE_VERSION) == VerificationResult.INVALID_ARTIFACT


# ---------------------------------------------------------------------------
# 2. ENGINE_VERSION_FAILURE
# ---------------------------------------------------------------------------


def test_wrong_engine_version_returns_version_failure(tmp_path):
    paths = _build_clean_bundle(tmp_path, "old-version")
    assert (
        verify_replay_run(paths.run_dir, "9.9.9") == VerificationResult.ENGINE_VERSION_FAILURE
    )


def test_empty_version_string_mismatches(tmp_path):
    paths = _build_clean_bundle(tmp_path, "empty-ver")
    assert (
        verify_replay_run(paths.run_dir, "") == VerificationResult.ENGINE_VERSION_FAILURE
    )


# ---------------------------------------------------------------------------
# 3. SEED_MISMATCH
# ---------------------------------------------------------------------------


def test_corrupted_seed_bytes_returns_seed_mismatch(tmp_path):
    paths = _build_clean_bundle(tmp_path, "bad-seed")
    paths.seed_path.write_bytes(b"corrupted content")
    assert verify_replay_run(paths.run_dir, _ENGINE_VERSION) == VerificationResult.SEED_MISMATCH


def test_seed_with_regenerated_hash_bypasses_hash_but_triggers_frame_check(tmp_path):
    """If someone replaces seed with a different snapshot AND updates the manifest hash,
    the frame alignment check catches the mismatch when seed.frame != archived_track[0].frame."""
    paths = _build_clean_bundle(tmp_path, "swapped-seed")

    # Write a different seed (frame=99) and update its hash in manifest
    different_seed = _make_seed(frame=99)
    new_seed_bytes = json.dumps(
        different_seed.to_dict(), sort_keys=True, indent=2
    ).encode("utf-8")
    paths.seed_path.write_bytes(new_seed_bytes)

    manifest = json.loads(paths.manifest_path.read_text(encoding="utf-8"))
    manifest["seed_sha256"] = hashlib.sha256(new_seed_bytes).hexdigest()
    paths.manifest_path.write_text(json.dumps(manifest, sort_keys=True, indent=2), encoding="utf-8")

    result = verify_replay_run(paths.run_dir, _ENGINE_VERSION)
    assert result == VerificationResult.FRAME_ALIGNMENT_FAILURE


# ---------------------------------------------------------------------------
# 4. HASH_FAILURE (truth track tampered, hash NOT updated)
# ---------------------------------------------------------------------------


def test_truth_track_byte_corruption_returns_hash_failure(tmp_path):
    paths = _build_clean_bundle(tmp_path, "corrupted-track")
    original = paths.truth_track_path.read_bytes()
    # Flip a byte in the middle of the payload
    corrupted = original[:50] + bytes([original[50] ^ 0xFF]) + original[51:]
    paths.truth_track_path.write_bytes(corrupted)
    assert verify_replay_run(paths.run_dir, _ENGINE_VERSION) == VerificationResult.HASH_FAILURE


# ---------------------------------------------------------------------------
# 5. REPLAY_DIVERGED — tampered content with updated hash
# ---------------------------------------------------------------------------


def test_tampered_truth_track_hash_updated_returns_replay_diverged(tmp_path):
    """File is internally consistent (hash matches) but content is mechanically false."""
    seed = _make_seed(frame=0)
    frame_1 = step_frame(seed)

    # Tamper frame 1: move attacker to a position step_frame would never produce
    tampered_frame_1 = replace(
        frame_1,
        attacker=replace(
            frame_1.attacker,
            kinematics=replace(
                frame_1.attacker.kinematics,
                position=Vec2("14.000000", "4.000000"),
            ),
        ),
    )
    tampered_track = [seed, tampered_frame_1]

    # Write tampered bundle with correct hashes for the tampered content
    seed_bytes = json.dumps(seed.to_dict(), sort_keys=True, indent=2).encode("utf-8")
    truth_bytes = json.dumps(
        [s.to_dict() for s in tampered_track], sort_keys=True, indent=2
    ).encode("utf-8")
    manifest = {
        "engine_version": _ENGINE_VERSION,
        "run_id": "tampered-run",
        "seed_sha256": hashlib.sha256(seed_bytes).hexdigest(),
        "timestamp": "2026-07-08T00:00:00Z",
        "truth_track_sha256": hashlib.sha256(truth_bytes).hexdigest(),
    }

    run_dir = tmp_path / "tampered-run"
    run_dir.mkdir()
    (run_dir / "seed_snapshot.json").write_bytes(seed_bytes)
    (run_dir / "truth_track.json").write_bytes(truth_bytes)
    (run_dir / "manifest.json").write_text(
        json.dumps(manifest, sort_keys=True, indent=2), encoding="utf-8"
    )

    assert verify_replay_run(run_dir, _ENGINE_VERSION) == VerificationResult.REPLAY_DIVERGED


def test_ball_position_divergence_returns_replay_diverged(tmp_path):
    seed = _make_seed(frame=0)
    real_frame_1 = step_frame(seed)
    diverged_frame_1 = replace(
        real_frame_1,
        ball=replace(real_frame_1.ball, position=Vec2("5.000000", "0.000000")),
    )
    diverged_track = [seed, diverged_frame_1]

    seed_bytes = json.dumps(seed.to_dict(), sort_keys=True, indent=2).encode("utf-8")
    truth_bytes = json.dumps(
        [s.to_dict() for s in diverged_track], sort_keys=True, indent=2
    ).encode("utf-8")
    manifest = {
        "engine_version": _ENGINE_VERSION,
        "run_id": "ball-diverge",
        "seed_sha256": hashlib.sha256(seed_bytes).hexdigest(),
        "timestamp": "2026-07-08T00:00:00Z",
        "truth_track_sha256": hashlib.sha256(truth_bytes).hexdigest(),
    }
    run_dir = tmp_path / "ball-diverge"
    run_dir.mkdir()
    (run_dir / "seed_snapshot.json").write_bytes(seed_bytes)
    (run_dir / "truth_track.json").write_bytes(truth_bytes)
    (run_dir / "manifest.json").write_text(
        json.dumps(manifest, sort_keys=True, indent=2), encoding="utf-8"
    )
    assert verify_replay_run(run_dir, _ENGINE_VERSION) == VerificationResult.REPLAY_DIVERGED


# ---------------------------------------------------------------------------
# 6. VERIFIED — clean runs
# ---------------------------------------------------------------------------


def test_clean_single_frame_bundle_returns_verified(tmp_path):
    paths = _build_clean_bundle(tmp_path, "verify-1", n_frames=1)
    assert verify_replay_run(paths.run_dir, _ENGINE_VERSION) == VerificationResult.VERIFIED


def test_clean_two_frame_bundle_returns_verified(tmp_path):
    paths = _build_clean_bundle(tmp_path, "verify-2", n_frames=2)
    assert verify_replay_run(paths.run_dir, _ENGINE_VERSION) == VerificationResult.VERIFIED


def test_clean_ten_frame_bundle_returns_verified(tmp_path):
    paths = _build_clean_bundle(tmp_path, "verify-10", n_frames=10)
    assert verify_replay_run(paths.run_dir, _ENGINE_VERSION) == VerificationResult.VERIFIED


# ---------------------------------------------------------------------------
# 7. Engine regression detected — FrameStepper monkeypatch
# ---------------------------------------------------------------------------


def test_step_frame_regression_causes_replay_diverged(tmp_path, monkeypatch):
    """If step_frame behaviour changes, verification catches the mismatch."""
    paths = _build_clean_bundle(tmp_path, "regression", n_frames=2)

    def _broken_step(snapshot: GameSnapshot) -> GameSnapshot:
        real = step_frame(snapshot)
        # Inject a position offset the real engine never produces
        return replace(
            real,
            attacker=replace(
                real.attacker,
                kinematics=replace(
                    real.attacker.kinematics,
                    position=Vec2(
                        str(real.attacker.kinematics.position.x + fp("1.0")),
                        str(real.attacker.kinematics.position.y),
                    ),
                ),
            ),
        )

    # Patch the name where the verifier uses it, not where it's defined
    monkeypatch.setattr("engine.replay_verifier.step_frame", _broken_step)
    assert verify_replay_run(paths.run_dir, _ENGINE_VERSION) == VerificationResult.REPLAY_DIVERGED


def test_engine_exception_propagates_loudly(tmp_path, monkeypatch):
    """Real engine bugs must not be silently swallowed as INVALID_ARTIFACT."""
    paths = _build_clean_bundle(tmp_path, "loud-fail", n_frames=2)

    def _exploding_step(snapshot: GameSnapshot) -> GameSnapshot:
        raise RuntimeError("Simulated engine panic: fixed-point overflow")

    monkeypatch.setattr("engine.replay_verifier.step_frame", _exploding_step)
    with pytest.raises(RuntimeError, match="Simulated engine panic"):
        verify_replay_run(paths.run_dir, _ENGINE_VERSION)


# ---------------------------------------------------------------------------
# 8. Evidence artifact cannot override replay result
# ---------------------------------------------------------------------------


def test_verdict_in_bundle_cannot_certify_diverged_run(tmp_path):
    """Even if a stored evidence says IDENTICAL_TRACKS, diverged physics wins."""
    # This is the key architectural property: the verifier ignores stored verdicts.
    # We build a bundle whose truth_track diverges from what step_frame would produce,
    # then confirm the result is REPLAY_DIVERGED regardless.
    seed = _make_seed(frame=0)
    real_frame_1 = step_frame(seed)
    lying_frame_1 = replace(
        real_frame_1,
        defender=replace(
            real_frame_1.defender,
            belief=replace(
                real_frame_1.defender.belief,
                threat_level=fp("0.999999"),
            ),
        ),
    )
    track = [seed, lying_frame_1]

    seed_bytes = json.dumps(seed.to_dict(), sort_keys=True, indent=2).encode("utf-8")
    truth_bytes = json.dumps(
        [s.to_dict() for s in track], sort_keys=True, indent=2
    ).encode("utf-8")
    manifest = {
        "engine_version": _ENGINE_VERSION,
        "run_id": "self-cert",
        "seed_sha256": hashlib.sha256(seed_bytes).hexdigest(),
        "timestamp": "2026-07-08T00:00:00Z",
        "truth_track_sha256": hashlib.sha256(truth_bytes).hexdigest(),
        # A lying field that the verifier must ignore
        "stored_verdict": "IDENTICAL_TRACKS",
    }
    run_dir = tmp_path / "self-cert"
    run_dir.mkdir()
    (run_dir / "seed_snapshot.json").write_bytes(seed_bytes)
    (run_dir / "truth_track.json").write_bytes(truth_bytes)
    (run_dir / "manifest.json").write_text(
        json.dumps(manifest, sort_keys=True, indent=2), encoding="utf-8"
    )
    assert verify_replay_run(run_dir, _ENGINE_VERSION) == VerificationResult.REPLAY_DIVERGED

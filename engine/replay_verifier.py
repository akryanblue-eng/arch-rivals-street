"""M5 — Replay verifier: cryptographic + mechanical truth gate.

verify_replay_run(artifact_dir, expected_engine_version) -> VerificationResult

The verifier treats the simulation engine as the sole authority on truth.
The artifact on disk is only a receipt. Verification requires the engine to
independently reconstruct the timeline from the seed snapshot and then
compare that reconstruction against the archived track frame-by-frame.

Decision path:
    manifest.json exists + seed_snapshot.json exists + truth_track.json exists
        │ missing any file → INVALID_ARTIFACT
        ↓
    manifest["engine_version"] == expected_engine_version
        │ mismatch → ENGINE_VERSION_FAILURE
        ↓
    SHA-256(seed_snapshot.json bytes) == manifest["seed_sha256"]
        │ mismatch → SEED_MISMATCH
        ↓
    SHA-256(truth_track.json bytes) == manifest["truth_track_sha256"]
        │ mismatch → HASH_FAILURE
        ↓
    Deserialize seed + archived_track via GameSnapshot.from_dict()
        │ schema error → INVALID_ARTIFACT
        ↓
    archived_track[0].frame == seed_snapshot.frame
        │ mismatch → FRAME_ALIGNMENT_FAILURE
        ↓
    Regenerate timeline: step_frame() × (len(archived_track) - 1)
        │ engine regression propagates loudly — NOT caught here
        ↓
    observe_tracks(archived_track, regenerated_track)
        │ ValueError → FRAME_ALIGNMENT_FAILURE
        ↓
    first_divergence_frame is None → VERIFIED
    first_divergence_frame is not None → REPLAY_DIVERGED

Engine exceptions (physics bugs, arithmetic errors) are intentionally NOT
caught so they surface as real failures rather than being silently classified
as INVALID_ARTIFACT.
"""

from __future__ import annotations

import hashlib
import json
from enum import Enum, auto
from pathlib import Path

from engine.drift_observer import observe_tracks
from engine.frame_stepper import step_frame
from engine.game_state import GameSnapshot


class VerificationResult(Enum):
    VERIFIED = auto()
    HASH_FAILURE = auto()
    REPLAY_DIVERGED = auto()
    INVALID_ARTIFACT = auto()
    SEED_MISMATCH = auto()
    FRAME_ALIGNMENT_FAILURE = auto()
    ENGINE_VERSION_FAILURE = auto()


def verify_replay_run(
    artifact_dir: Path,
    expected_engine_version: str,
) -> VerificationResult:
    """Cryptographically and mechanically verify a prior simulation run.

    Parameters
    ----------
    artifact_dir:
        Directory produced by write_replay_bundle(); must contain
        seed_snapshot.json, truth_track.json, and manifest.json.
    expected_engine_version:
        Semantic version string the caller expects. If the bundle was
        produced by a different engine version, ENGINE_VERSION_FAILURE is
        returned before any file content is read.

    Returns
    -------
    VerificationResult
        One of the seven result codes described in the module docstring.
    """
    manifest_path = artifact_dir / "manifest.json"
    seed_path = artifact_dir / "seed_snapshot.json"
    truth_track_path = artifact_dir / "truth_track.json"

    # --- 1. File presence check ------------------------------------------
    if not (manifest_path.exists() and seed_path.exists() and truth_track_path.exists()):
        return VerificationResult.INVALID_ARTIFACT

    # --- 2. Manifest parse -----------------------------------------------
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, IOError):
        return VerificationResult.INVALID_ARTIFACT

    # --- 3. Engine version guard -----------------------------------------
    if manifest.get("engine_version") != expected_engine_version:
        return VerificationResult.ENGINE_VERSION_FAILURE

    # --- 4. Read raw bytes for hashing -----------------------------------
    try:
        seed_bytes = seed_path.read_bytes()
        truth_bytes = truth_track_path.read_bytes()
    except IOError:
        return VerificationResult.INVALID_ARTIFACT

    # --- 5. Cryptographic integrity --------------------------------------
    if hashlib.sha256(seed_bytes).hexdigest() != manifest.get("seed_sha256"):
        return VerificationResult.SEED_MISMATCH

    if hashlib.sha256(truth_bytes).hexdigest() != manifest.get("truth_track_sha256"):
        return VerificationResult.HASH_FAILURE

    # --- 6. Deserialize --------------------------------------------------
    try:
        seed_snapshot = GameSnapshot.from_dict(json.loads(seed_bytes.decode("utf-8")))
        archived_track = [
            GameSnapshot.from_dict(d)
            for d in json.loads(truth_bytes.decode("utf-8"))
        ]
    except (KeyError, ValueError, TypeError):
        return VerificationResult.INVALID_ARTIFACT

    if not archived_track:
        return VerificationResult.INVALID_ARTIFACT

    if archived_track[0].frame != seed_snapshot.frame:
        return VerificationResult.FRAME_ALIGNMENT_FAILURE

    # --- 7. Engine-authoritative reconstruction --------------------------
    # Intentionally no try/except: real engine regressions must fail loudly.
    regenerated_track: list[GameSnapshot] = [seed_snapshot]
    current = seed_snapshot
    for _ in range(len(archived_track) - 1):
        current = step_frame(current)
        regenerated_track.append(current)

    # --- 8. Frame-by-frame comparison ------------------------------------
    try:
        report = observe_tracks(archived_track, regenerated_track)
    except ValueError:
        return VerificationResult.FRAME_ALIGNMENT_FAILURE

    if report.first_divergence_frame is not None:
        return VerificationResult.REPLAY_DIVERGED

    return VerificationResult.VERIFIED

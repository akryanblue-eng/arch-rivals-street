"""M4 Part 2 / M5 — Replay artifact writers: content-hashed filesystem bundles.

Two writers, two separate contracts:

create_replay_artifact(evidence, artifact_root)
    Writes an EvidenceRecord to:
        artifacts/runs/<run_id>/
            evidence.json   — full canonical evidence payload
            manifest.json   — run_id, timestamp, sha256 of evidence.json

write_replay_bundle(run_id, engine_version, timestamp, seed_snapshot, truth_track, artifact_root)
    Writes the full verifier bundle to:
        artifacts/runs/<run_id>/
            seed_snapshot.json  — initial GameSnapshot (canonical to_dict format)
            truth_track.json    — list of GameSnapshot dicts for the archived run
            manifest.json       — engine_version, run_id, seed_sha256, truth_track_sha256

SHA-256 digests are computed from the bytes written to disk, not from
in-memory dicts, so manifests are always faithful content addresses.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from engine.evidence_schema import EvidenceRecord
from engine.game_state import GameSnapshot

_ARTIFACT_ROOT = Path("artifacts/runs")


@dataclass(frozen=True)
class ReplayArtifactPaths:
    """Paths written by create_replay_artifact."""

    run_dir: Path
    evidence_path: Path
    manifest_path: Path


def create_replay_artifact(
    evidence: EvidenceRecord,
    artifact_root: Path | None = None,
) -> ReplayArtifactPaths:
    """Write evidence bundle to disk and return the paths created.

    Parameters
    ----------
    evidence:
        Fully-populated EvidenceRecord to persist.
    artifact_root:
        Parent directory for all run sub-directories. Defaults to
        ``artifacts/runs`` relative to the current working directory.
        Override in tests to avoid writing into the project tree.

    Returns
    -------
    ReplayArtifactPaths
        Frozen record of every path written.

    Raises
    ------
    FileExistsError
        If the run directory already exists (prevents silent overwrite of a
        prior run with the same UUID).
    """
    root = artifact_root if artifact_root is not None else _ARTIFACT_ROOT
    run_dir = root / evidence.run_id

    if run_dir.exists():
        raise FileExistsError(
            f"Artifact directory already exists for run_id {evidence.run_id!r}: {run_dir}"
        )

    run_dir.mkdir(parents=True, exist_ok=False)

    # --- evidence.json ---------------------------------------------------
    evidence_path = run_dir / "evidence.json"
    evidence_bytes = json.dumps(
        evidence.to_canonical_dict(), sort_keys=True, indent=2
    ).encode("utf-8")
    evidence_path.write_bytes(evidence_bytes)

    # --- SHA-256 over the written bytes (not the in-memory dict) ---------
    sha256_digest = hashlib.sha256(evidence_bytes).hexdigest()

    # --- manifest.json ---------------------------------------------------
    manifest_path = run_dir / "manifest.json"
    manifest = {
        "run_id": evidence.run_id,
        "timestamp": evidence.timestamp,
        "evidence_sha256": sha256_digest,
    }
    manifest_path.write_text(
        json.dumps(manifest, sort_keys=True, indent=2), encoding="utf-8"
    )

    return ReplayArtifactPaths(
        run_dir=run_dir,
        evidence_path=evidence_path,
        manifest_path=manifest_path,
    )


# ---------------------------------------------------------------------------
# M5 — Verifier bundle writer
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ReplayBundlePaths:
    """Paths written by write_replay_bundle."""

    run_dir: Path
    seed_path: Path
    truth_track_path: Path
    manifest_path: Path


def write_replay_bundle(
    run_id: str,
    engine_version: str,
    timestamp: str,
    seed_snapshot: GameSnapshot,
    truth_track: list[GameSnapshot],
    artifact_root: Path | None = None,
) -> ReplayBundlePaths:
    """Write a verifier bundle (seed + track + manifest) to disk.

    The bundle is the authority for M5 replay verification:
    - seed_snapshot.json is the deterministic start state
    - truth_track.json is the full archived timeline (includes seed frame)
    - manifest.json cryptographically binds both files

    Parameters
    ----------
    run_id:
        UUID string; becomes the sub-directory name under artifact_root.
    engine_version:
        Semantic version of the engine that produced this run. The verifier
        refuses bundles whose stored version does not match its expectation.
    timestamp:
        ISO-8601 UTC string recorded at bundle creation time.
    seed_snapshot:
        Initial GameSnapshot (frame 0) from which the run was launched.
    truth_track:
        All snapshots in the archived run, starting with the seed frame.
    artifact_root:
        Parent directory; defaults to ``artifacts/runs``.

    Raises
    ------
    FileExistsError
        If the run directory already exists.
    """
    root = artifact_root if artifact_root is not None else _ARTIFACT_ROOT
    run_dir = root / run_id

    if run_dir.exists():
        raise FileExistsError(
            f"Artifact directory already exists for run_id {run_id!r}: {run_dir}"
        )

    run_dir.mkdir(parents=True, exist_ok=False)

    # --- seed_snapshot.json ----------------------------------------------
    seed_path = run_dir / "seed_snapshot.json"
    seed_bytes = json.dumps(
        seed_snapshot.to_dict(), sort_keys=True, indent=2
    ).encode("utf-8")
    seed_path.write_bytes(seed_bytes)
    seed_sha256 = hashlib.sha256(seed_bytes).hexdigest()

    # --- truth_track.json ------------------------------------------------
    truth_track_path = run_dir / "truth_track.json"
    truth_bytes = json.dumps(
        [snap.to_dict() for snap in truth_track], sort_keys=True, indent=2
    ).encode("utf-8")
    truth_track_path.write_bytes(truth_bytes)
    truth_track_sha256 = hashlib.sha256(truth_bytes).hexdigest()

    # --- manifest.json ---------------------------------------------------
    manifest_path = run_dir / "manifest.json"
    manifest = {
        "engine_version": engine_version,
        "run_id": run_id,
        "seed_sha256": seed_sha256,
        "timestamp": timestamp,
        "truth_track_sha256": truth_track_sha256,
    }
    manifest_path.write_text(
        json.dumps(manifest, sort_keys=True, indent=2), encoding="utf-8"
    )

    return ReplayBundlePaths(
        run_dir=run_dir,
        seed_path=seed_path,
        truth_track_path=truth_track_path,
        manifest_path=manifest_path,
    )

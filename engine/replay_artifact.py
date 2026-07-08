"""M4 Part 2 — Replay artifact writer: content-hashed filesystem bundle.

create_replay_artifact(evidence, artifact_root) writes an EvidenceRecord to:

    artifacts/runs/<run_id>/
        evidence.json      — full canonical evidence payload
        manifest.json      — run_id, timestamp, sha256 of evidence.json

The SHA-256 digest in manifest.json is computed from evidence.json content
after it is written, so the manifest always reflects the actual bytes on disk.

Nothing is read from disk during artifact creation — the pipeline is
write-only at this stage. Verification (re-reading and hashing) is the
responsibility of engine/replay_verifier.py (M5).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from engine.evidence_schema import EvidenceRecord

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

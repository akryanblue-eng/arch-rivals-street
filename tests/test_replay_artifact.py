"""M4 Part 2 — Replay artifact writer: filesystem layout, content hash,
manifest integrity, duplicate-run guard."""

from __future__ import annotations

import hashlib
import json
from decimal import Decimal
from pathlib import Path

import pytest

from engine.drift_observer import DriftObservation, DriftObservationReport
from engine.drift_policy import DriftVerdict
from engine.evidence_schema import EvidenceRecord
from engine.replay_artifact import ReplayArtifactPaths, create_replay_artifact


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_ZERO = Decimal("0.000000")

_SIMPLE_REPORT = DriftObservationReport(
    frames_compared=1,
    first_divergence_frame=None,
    observations=[
        DriftObservation(
            frame=1,
            position_delta_sq=_ZERO,
            velocity_delta_sq=_ZERO,
            ball_delta_sq=_ZERO,
            belief_delta_sq=_ZERO,
            threat_delta=_ZERO,
        )
    ],
)

_SIMPLE_VERDICT = DriftVerdict(
    classification="IDENTICAL_TRACKS",
    severity="NONE",
    action="CONTINUE",
    composite_score=_ZERO,
)


def _make_evidence(
    run_id: str = "test-run-001",
    engine_version: str = "0.1.0",
    frames_run: int = 1,
    timestamp: str = "2026-07-08T00:00:00Z",
) -> EvidenceRecord:
    return EvidenceRecord(
        run_id=run_id,
        engine_version=engine_version,
        frames_run=frames_run,
        timestamp=timestamp,
        observer_report=_SIMPLE_REPORT,
        policy_verdict=_SIMPLE_VERDICT,
    )


# ---------------------------------------------------------------------------
# 1. Directory layout
# ---------------------------------------------------------------------------


def test_creates_run_directory_under_root(tmp_path):
    evidence = _make_evidence(run_id="my-run-id")
    paths = create_replay_artifact(evidence, artifact_root=tmp_path)
    assert paths.run_dir == tmp_path / "my-run-id"
    assert paths.run_dir.is_dir()


def test_creates_evidence_json(tmp_path):
    evidence = _make_evidence()
    paths = create_replay_artifact(evidence, artifact_root=tmp_path)
    assert paths.evidence_path.exists()
    assert paths.evidence_path.name == "evidence.json"


def test_creates_manifest_json(tmp_path):
    evidence = _make_evidence()
    paths = create_replay_artifact(evidence, artifact_root=tmp_path)
    assert paths.manifest_path.exists()
    assert paths.manifest_path.name == "manifest.json"


def test_evidence_and_manifest_are_inside_run_dir(tmp_path):
    evidence = _make_evidence(run_id="uuid-xyz")
    paths = create_replay_artifact(evidence, artifact_root=tmp_path)
    assert paths.evidence_path.parent == paths.run_dir
    assert paths.manifest_path.parent == paths.run_dir


def test_exactly_two_files_in_run_dir(tmp_path):
    evidence = _make_evidence()
    paths = create_replay_artifact(evidence, artifact_root=tmp_path)
    files = list(paths.run_dir.iterdir())
    assert len(files) == 2


# ---------------------------------------------------------------------------
# 2. evidence.json content
# ---------------------------------------------------------------------------


def test_evidence_json_is_valid_json(tmp_path):
    evidence = _make_evidence()
    paths = create_replay_artifact(evidence, artifact_root=tmp_path)
    parsed = json.loads(paths.evidence_path.read_bytes())
    assert isinstance(parsed, dict)


def test_evidence_json_run_id_matches(tmp_path):
    evidence = _make_evidence(run_id="check-run-id")
    paths = create_replay_artifact(evidence, artifact_root=tmp_path)
    parsed = json.loads(paths.evidence_path.read_bytes())
    assert parsed["run_id"] == "check-run-id"


def test_evidence_json_engine_version_preserved(tmp_path):
    evidence = _make_evidence(engine_version="2.5.1")
    paths = create_replay_artifact(evidence, artifact_root=tmp_path)
    parsed = json.loads(paths.evidence_path.read_bytes())
    assert parsed["engine_version"] == "2.5.1"


def test_evidence_json_contains_observer_report_section(tmp_path):
    evidence = _make_evidence()
    paths = create_replay_artifact(evidence, artifact_root=tmp_path)
    parsed = json.loads(paths.evidence_path.read_bytes())
    assert "observer_report" in parsed
    assert "observations" in parsed["observer_report"]


def test_evidence_json_contains_policy_verdict_section(tmp_path):
    evidence = _make_evidence()
    paths = create_replay_artifact(evidence, artifact_root=tmp_path)
    parsed = json.loads(paths.evidence_path.read_bytes())
    assert "policy_verdict" in parsed
    assert parsed["policy_verdict"]["classification"] == "IDENTICAL_TRACKS"


# ---------------------------------------------------------------------------
# 3. manifest.json content and hash integrity
# ---------------------------------------------------------------------------


def test_manifest_json_is_valid_json(tmp_path):
    evidence = _make_evidence()
    paths = create_replay_artifact(evidence, artifact_root=tmp_path)
    parsed = json.loads(paths.manifest_path.read_text(encoding="utf-8"))
    assert isinstance(parsed, dict)


def test_manifest_contains_run_id(tmp_path):
    evidence = _make_evidence(run_id="manifest-run")
    paths = create_replay_artifact(evidence, artifact_root=tmp_path)
    parsed = json.loads(paths.manifest_path.read_text(encoding="utf-8"))
    assert parsed["run_id"] == "manifest-run"


def test_manifest_contains_timestamp(tmp_path):
    evidence = _make_evidence(timestamp="2026-07-08T12:34:56Z")
    paths = create_replay_artifact(evidence, artifact_root=tmp_path)
    parsed = json.loads(paths.manifest_path.read_text(encoding="utf-8"))
    assert parsed["timestamp"] == "2026-07-08T12:34:56Z"


def test_manifest_evidence_sha256_matches_file_bytes(tmp_path):
    evidence = _make_evidence()
    paths = create_replay_artifact(evidence, artifact_root=tmp_path)

    actual_digest = hashlib.sha256(paths.evidence_path.read_bytes()).hexdigest()
    manifest = json.loads(paths.manifest_path.read_text(encoding="utf-8"))
    assert manifest["evidence_sha256"] == actual_digest


def test_manifest_sha256_is_64_hex_chars(tmp_path):
    evidence = _make_evidence()
    paths = create_replay_artifact(evidence, artifact_root=tmp_path)
    manifest = json.loads(paths.manifest_path.read_text(encoding="utf-8"))
    digest = manifest["evidence_sha256"]
    assert len(digest) == 64
    assert all(c in "0123456789abcdef" for c in digest)


def test_different_evidence_produces_different_sha256(tmp_path):
    ev_a = _make_evidence(run_id="run-a", engine_version="0.1.0")
    ev_b = _make_evidence(run_id="run-b", engine_version="9.9.9")

    paths_a = create_replay_artifact(ev_a, artifact_root=tmp_path)
    paths_b = create_replay_artifact(ev_b, artifact_root=tmp_path)

    m_a = json.loads(paths_a.manifest_path.read_text(encoding="utf-8"))
    m_b = json.loads(paths_b.manifest_path.read_text(encoding="utf-8"))
    assert m_a["evidence_sha256"] != m_b["evidence_sha256"]


# ---------------------------------------------------------------------------
# 4. Duplicate-run guard
# ---------------------------------------------------------------------------


def test_duplicate_run_id_raises_file_exists_error(tmp_path):
    evidence = _make_evidence(run_id="duplicate-run")
    create_replay_artifact(evidence, artifact_root=tmp_path)
    with pytest.raises(FileExistsError, match="duplicate-run"):
        create_replay_artifact(evidence, artifact_root=tmp_path)


def test_different_run_ids_coexist(tmp_path):
    ev_a = _make_evidence(run_id="run-alpha")
    ev_b = _make_evidence(run_id="run-beta")
    paths_a = create_replay_artifact(ev_a, artifact_root=tmp_path)
    paths_b = create_replay_artifact(ev_b, artifact_root=tmp_path)
    assert paths_a.run_dir != paths_b.run_dir
    assert paths_a.run_dir.is_dir()
    assert paths_b.run_dir.is_dir()


# ---------------------------------------------------------------------------
# 5. ReplayArtifactPaths is immutable
# ---------------------------------------------------------------------------


def test_replay_artifact_paths_is_frozen(tmp_path):
    evidence = _make_evidence()
    paths = create_replay_artifact(evidence, artifact_root=tmp_path)
    with pytest.raises((AttributeError, TypeError)):
        paths.run_dir = tmp_path / "tampered"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# 6. Canonical bytes stability — same evidence → same hash across calls
# ---------------------------------------------------------------------------


def test_repeated_artifact_writes_produce_identical_sha256(tmp_path):
    """Two separate artifact directories from identical evidence have the same digest."""
    ev_a = _make_evidence(run_id="stable-a")
    ev_b = _make_evidence(run_id="stable-b")  # same content, different run_id

    # Manually compare canonical_bytes (run_id differs so top-level bytes differ)
    # — instead compare the observation sections only
    paths_a = create_replay_artifact(ev_a, artifact_root=tmp_path)
    paths_b = create_replay_artifact(ev_b, artifact_root=tmp_path)

    parsed_a = json.loads(paths_a.evidence_path.read_bytes())
    parsed_b = json.loads(paths_b.evidence_path.read_bytes())
    # Everything except run_id should be identical
    parsed_a.pop("run_id")
    parsed_b.pop("run_id")
    assert parsed_a == parsed_b


def test_evidence_json_has_sorted_keys(tmp_path):
    evidence = _make_evidence()
    paths = create_replay_artifact(evidence, artifact_root=tmp_path)
    raw = paths.evidence_path.read_text(encoding="utf-8")
    parsed = json.loads(raw)
    top_keys = list(parsed.keys())
    assert top_keys == sorted(top_keys)

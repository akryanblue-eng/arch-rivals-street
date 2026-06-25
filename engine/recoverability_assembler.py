"""Probe -> Gate contract compiler.

Pure transformer: reads a probe report (plus optional drift metrics) and
emits a schema-valid recoverability gate result. It does not compute truth
itself — it applies explicit rules to evidence the probe already collected,
and refuses to emit a result that doesn't validate against gate.schema.json.

No side effects beyond reading the probe file and writing the gate file:
no git, no Unity, no network.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from engine.drift_scoring import DriftMetrics, compute_drift_score, known_metric_fields

SPEC_VERSION = "0.1"
SCHEMA_PATH = Path(__file__).parent / "schemas" / "gate.schema.json"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_text(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def load_json(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: str, obj: dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, sort_keys=True, indent=2)


def _artifact(kind: str, path: str, sha256: str | None = None) -> dict[str, Any]:
    return {"kind": kind, "path": path, "sha256": sha256}


def _stage(
    name: str,
    status: str,
    started_utc: str,
    ended_utc: str,
    details: dict[str, Any] | None = None,
    artifacts: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "name": name,
        "status": status,
        "started_utc": started_utc,
        "ended_utc": ended_utc,
        "details": details or {},
        "artifacts": artifacts or [],
    }


def derive_observability(observations: dict[str, Any]) -> str:
    """Classify how much of the project this run was actually able to see.

    Kept separate from `verdict`: verdict is a rule-bound pass/fail judgment,
    observability is a description of what evidence was even available to
    judge. A FAIL with observability=STRUCTURAL_ONLY means "boot was never
    attempted", which reads very differently from a FAIL after a real attempt.
    """
    if not observations.get("unity_structure_ok", False):
        return "NONE"
    if not observations.get("unity_boot_attempted", False):
        return "STRUCTURAL_ONLY"
    if observations.get("unity_boot_ok", False):
        return "FULL"
    return "EXECUTABLE_ATTEMPTED"


def derive_environment(probe: dict[str, Any]) -> dict[str, Any]:
    ev = probe.get("evidence", {})
    fingerprint = ev.get("runner_fingerprint", {}) or {}
    return {
        "fresh_clone": True,
        "isolated": bool(ev.get("workdir_is_temp", False)),
        "runner": str(fingerprint.get("os", "unknown")),
        "os": str(fingerprint.get("os", "unknown")),
        "unity_version": ev.get("unity_version"),
        "observability": derive_observability(probe.get("observations", {})),
    }


def compute_verdict_and_notes(probe: dict[str, Any], drift: dict[str, Any]) -> tuple[str, list[str]]:
    notes: list[str] = []
    observations = probe.get("observations", {})

    # Hard blocker: there is nothing to evaluate recoverability of.
    # This is not a failure — it's an absence of observability.
    structure_ok = bool(observations.get("unity_structure_ok", False))
    if not structure_ok:
        notes.append(
            "BLOCKED: Unity project structure missing "
            "(Assets/Packages/ProjectSettings not present in fresh clone)."
        )
        return "BLOCKED", notes

    unity_boot_ok = bool(observations.get("unity_boot_ok", False))
    if not unity_boot_ok:
        notes.append("FAIL: Unity boot probe failed in isolated fresh workspace.")
        return "FAIL", notes

    classification = drift.get("classification", "CRITICAL")
    if classification == "CRITICAL":
        notes.append("FAIL: Drift classification CRITICAL.")
        return "FAIL", notes
    if classification == "MAJOR":
        notes.append("WARN: Drift classification MAJOR.")
        return "WARN", notes

    return "PASS", notes


def assemble_gate_result(
    probe: dict[str, Any],
    *,
    repo: str,
    commit_sha: str,
    run_id: str | None = None,
    drift_metrics: DriftMetrics | None = None,
) -> dict[str, Any]:
    stages: list[dict[str, Any]] = []
    for sr in probe.get("subsystem_results", []):
        name = sr.get("name", "UNKNOWN")
        passed = bool(sr.get("passed", False))
        details = dict(sr.get("details", {}) or {})
        artifacts = [_artifact("path", p) for p in (sr.get("artifacts") or [])]
        stages.append(
            _stage(
                name=name,
                status="PASS" if passed else "FAIL",
                started_utc=probe.get("started_utc", _utc_now()),
                ended_utc=probe.get("ended_utc", _utc_now()),
                details=details,
                artifacts=artifacts,
            )
        )

    if drift_metrics is None:
        known = known_metric_fields()
        filtered = {k: v for k, v in (probe.get("metrics") or {}).items() if k in known}
        drift_metrics = DriftMetrics(**filtered)
    drift = compute_drift_score(drift_metrics)

    verdict, notes = compute_verdict_and_notes(probe, drift)
    ended = _utc_now()

    return {
        "spec_version": SPEC_VERSION,
        "run": {
            "run_id": run_id or probe.get("run_id") or _sha256_text(f"{commit_sha}-{ended}")[:16],
            "timestamp_utc": ended,
            "repo": repo,
            "commit": {"sha": commit_sha, "branch": None, "pr_number": None},
        },
        "environment": derive_environment(probe),
        "stages": stages,
        "drift": drift,
        "heal": {"attempted": False, "actions": [], "outcome": "NOT_APPLICABLE"},
        "verdict": verdict,
        "notes": notes,
    }


def validate_against_schema(result: dict[str, Any]) -> None:
    import jsonschema

    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    jsonschema.validate(instance=result, schema=schema)


def main() -> int:
    parser = argparse.ArgumentParser(description="Compile a probe report into a schema-valid gate result")
    parser.add_argument("--probe", required=True, help="Path to probe.json")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--out", default="gate.result.json")
    args = parser.parse_args()

    probe = load_json(args.probe)
    result = assemble_gate_result(probe, repo=args.repo, commit_sha=args.commit)
    validate_against_schema(result)
    write_json(args.out, result)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

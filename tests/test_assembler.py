import jsonschema
import pytest

from engine.recoverability_assembler import (
    SCHEMA_PATH,
    assemble_gate_result,
    compute_verdict_and_notes,
    derive_observability,
    validate_against_schema,
)
import json


def load_schema():
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def make_probe(
    structure_ok: bool, boot_ok: bool, metrics: dict | None = None, boot_attempted: bool | None = None
) -> dict:
    if boot_attempted is None:
        boot_attempted = structure_ok  # default: attempted whenever structure allowed it
    return {
        "run_id": "test-run",
        "started_utc": "2026-06-25T00:00:00+00:00",
        "ended_utc": "2026-06-25T00:00:05+00:00",
        "repo": "https://github.com/akryanblue-eng/arch-rivals-street",
        "requested_commit": "deadbeef",
        "evidence": {
            "workdir_is_temp": True,
            "git_head_sha": "deadbeef",
            "unity_version": "2022.3.10f1" if structure_ok else None,
            "runner_fingerprint": {"os": "Linux", "kernel": "6.18", "container_id": "abc"},
            "logs": {"clone": "Cloning..."},
            "artifacts": [],
        },
        "observations": {
            "unity_structure_ok": structure_ok,
            "unity_boot_attempted": boot_attempted,
            "unity_boot_ok": boot_ok,
        },
        "subsystem_results": [
            {"name": "FRESH_CLONE", "passed": True, "details": {}, "artifacts": []},
            {"name": "MANIFEST_VALIDATE", "passed": structure_ok, "details": {}, "artifacts": []},
            {"name": "UNITY_BOOT", "passed": boot_ok, "details": {}, "artifacts": []},
        ],
        "metrics": metrics or {},
    }


def test_missing_unity_structure_is_blocked_not_failed():
    probe = make_probe(structure_ok=False, boot_ok=False)
    verdict, notes = compute_verdict_and_notes(probe, drift={"classification": "STABLE"})
    assert verdict == "BLOCKED"
    assert any("structure missing" in n for n in notes)
    assert derive_observability(probe["observations"]) == "NONE"


def test_failed_unity_boot_is_fail():
    probe = make_probe(structure_ok=True, boot_ok=False)
    verdict, notes = compute_verdict_and_notes(probe, drift={"classification": "STABLE"})
    assert verdict == "FAIL"
    assert derive_observability(probe["observations"]) == "EXECUTABLE_ATTEMPTED"


def test_structure_ok_but_boot_not_attempted_is_structural_only():
    probe = make_probe(structure_ok=True, boot_ok=False, boot_attempted=False)
    assert derive_observability(probe["observations"]) == "STRUCTURAL_ONLY"


def test_critical_drift_overrides_to_fail():
    probe = make_probe(structure_ok=True, boot_ok=True)
    verdict, notes = compute_verdict_and_notes(probe, drift={"classification": "CRITICAL"})
    assert verdict == "FAIL"


def test_major_drift_is_warn():
    probe = make_probe(structure_ok=True, boot_ok=True)
    verdict, notes = compute_verdict_and_notes(probe, drift={"classification": "MAJOR"})
    assert verdict == "WARN"


def test_healthy_probe_passes():
    probe = make_probe(structure_ok=True, boot_ok=True)
    verdict, notes = compute_verdict_and_notes(probe, drift={"classification": "STABLE"})
    assert verdict == "PASS"
    assert notes == []
    assert derive_observability(probe["observations"]) == "FULL"


def test_assembled_blocked_result_validates_against_schema():
    probe = make_probe(structure_ok=False, boot_ok=False)
    result = assemble_gate_result(
        probe, repo="https://github.com/akryanblue-eng/arch-rivals-street", commit_sha="deadbeef"
    )
    assert result["verdict"] == "BLOCKED"
    assert result["environment"]["observability"] == "NONE"
    validate_against_schema(result)  # raises if invalid


def test_assembled_pass_result_validates_against_schema():
    probe = make_probe(structure_ok=True, boot_ok=True)
    result = assemble_gate_result(
        probe, repo="https://github.com/akryanblue-eng/arch-rivals-street", commit_sha="deadbeef"
    )
    assert result["verdict"] == "PASS"
    assert result["environment"]["observability"] == "FULL"
    validate_against_schema(result)


def test_unknown_metric_keys_are_ignored_not_fatal():
    probe = make_probe(structure_ok=True, boot_ok=True, metrics={"bogus_field": 1.0})
    # Should not raise despite the unrecognized metric key.
    result = assemble_gate_result(
        probe, repo="https://github.com/akryanblue-eng/arch-rivals-street", commit_sha="deadbeef"
    )
    assert result["verdict"] == "PASS"


def test_environment_fresh_clone_is_always_true():
    schema = load_schema()
    probe = make_probe(structure_ok=True, boot_ok=True)
    result = assemble_gate_result(
        probe, repo="https://github.com/akryanblue-eng/arch-rivals-street", commit_sha="deadbeef"
    )
    assert result["environment"]["fresh_clone"] is True
    jsonschema.validate(instance=result, schema=schema)

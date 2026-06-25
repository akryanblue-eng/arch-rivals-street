"""Recovery probe: the "reality reader" layer.

Clones a repo at a specific commit into an ephemeral workspace and records
raw evidence about whether the project is present and bootable. The probe
never scores or judges what it sees — it only reports observations. Scoring
lives in drift_scoring.py; verdict logic lives in recoverability_assembler.py.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any

UNITY_REQUIRED_PATHS = (
    "Assets",
    "Packages/manifest.json",
    "ProjectSettings/ProjectVersion.txt",
)


def run(cmd: list[str], cwd: str | None = None) -> tuple[bool, str, int]:
    """Deterministic execution primitive: no shell, no string interpolation."""
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, check=False)
    return proc.returncode == 0, proc.stdout + proc.stderr, proc.returncode


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_text(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Evidence:
    workdir_is_temp: bool
    git_head_sha: str | None
    unity_version: str | None
    runner_fingerprint: dict[str, Any]
    logs: dict[str, str]
    artifacts: list[str]


@dataclass
class SubsystemResult:
    name: str
    passed: bool
    details: dict[str, Any] = field(default_factory=dict)
    artifacts: list[str] = field(default_factory=list)


@dataclass
class ProbeReport:
    run_id: str
    started_utc: str
    ended_utc: str
    repo: str
    requested_commit: str
    evidence: Evidence
    observations: dict[str, Any]
    subsystem_results: list[SubsystemResult]
    metrics: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "started_utc": self.started_utc,
            "ended_utc": self.ended_utc,
            "repo": self.repo,
            "requested_commit": self.requested_commit,
            "evidence": asdict(self.evidence),
            "observations": self.observations,
            "subsystem_results": [asdict(r) for r in self.subsystem_results],
            "metrics": self.metrics,
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), sort_keys=True, indent=2)


def runner_fingerprint() -> dict[str, Any]:
    return {
        "os": platform.system(),
        "kernel": platform.release(),
        "container_id": os.environ.get("HOSTNAME"),
    }


def fresh_clone_at_commit(repo_url: str, commit: str, cwd: str) -> tuple[bool, str, str | None]:
    """Clone repo_url into cwd, then fetch + checkout commit as detached HEAD.

    Closes the "we probed main, not the commit under test" loophole: every
    probe run must prove which exact commit it inspected via `git rev-parse
    HEAD`, not just that *some* clone succeeded.
    """
    log_parts: list[str] = []

    ok, log, _ = run(["git", "clone", repo_url, cwd])
    log_parts.append(log)
    if not ok:
        return False, "\n".join(log_parts), None

    # Best-effort: commit may already be reachable from the default clone.
    run(["git", "fetch", "origin", commit], cwd=cwd)

    ok, log, _ = run(["git", "checkout", "--detach", commit], cwd=cwd)
    log_parts.append(log)
    if not ok:
        return False, "\n".join(log_parts), None

    ok, log, _ = run(["git", "rev-parse", "HEAD"], cwd=cwd)
    log_parts.append(log)
    head_sha = log.strip() if ok else None
    return ok, "\n".join(log_parts), head_sha


def unity_structure_ok(project_path: str) -> bool:
    return all(os.path.exists(os.path.join(project_path, p)) for p in UNITY_REQUIRED_PATHS)


def read_unity_version(project_path: str) -> str | None:
    version_file = os.path.join(project_path, "ProjectSettings", "ProjectVersion.txt")
    if not os.path.exists(version_file):
        return None
    with open(version_file, "r", encoding="utf-8") as f:
        for line in f:
            if line.startswith("m_EditorVersion:"):
                return line.split(":", 1)[1].strip()
    return None


def unity_boot(unity_path: str, project_path: str, log_artifact_path: str) -> SubsystemResult:
    started = time.monotonic()
    ok, output, code = run(
        [unity_path, "-batchmode", "-quit", "-nographics", "-projectPath", project_path]
    )
    duration_s = time.monotonic() - started

    os.makedirs(os.path.dirname(log_artifact_path), exist_ok=True)
    with open(log_artifact_path, "w", encoding="utf-8") as f:
        f.write(output)

    return SubsystemResult(
        name="UNITY_BOOT",
        passed=ok and code == 0,
        details={
            "exit_code": code,
            "duration_s": round(duration_s, 3),
            "log_sha256": _sha256_text(output),
            "log_tail": output[-1000:],
        },
        artifacts=[log_artifact_path],
    )


def run_probe(
    repo_url: str,
    commit: str,
    *,
    unity_path: str | None = None,
    run_id: str | None = None,
) -> ProbeReport:
    started = _utc_now()
    run_id = run_id or _sha256_text(f"{repo_url}@{commit}@{started}")[:16]

    with tempfile.TemporaryDirectory(prefix="recoverability_clone_") as workdir:
        clone_ok, clone_log, head_sha = fresh_clone_at_commit(repo_url, commit, workdir)

        subsystem_results: list[SubsystemResult] = [
            SubsystemResult(
                name="FRESH_CLONE",
                passed=clone_ok,
                details={"log_tail": clone_log[-1000:], "log_sha256": _sha256_text(clone_log)},
            )
        ]

        structure_ok = clone_ok and unity_structure_ok(workdir)
        subsystem_results.append(
            SubsystemResult(
                name="MANIFEST_VALIDATE",
                passed=structure_ok,
                details={"checked": list(UNITY_REQUIRED_PATHS)},
            )
        )

        unity_version = read_unity_version(workdir) if structure_ok else None

        boot_attempted = bool(structure_ok and unity_path)
        if boot_attempted:
            log_path = os.path.join(tempfile.gettempdir(), f"unity_boot_{run_id}.log")
            unity_result = unity_boot(unity_path, workdir, log_path)
        else:
            unity_result = SubsystemResult(
                name="UNITY_BOOT",
                passed=False,
                details={
                    "skipped": True,
                    "reason": "unity project structure absent or UNITY_PATH not configured",
                },
            )
        subsystem_results.append(unity_result)

        evidence = Evidence(
            workdir_is_temp=True,
            git_head_sha=head_sha,
            unity_version=unity_version,
            runner_fingerprint=runner_fingerprint(),
            logs={"clone": clone_log[-2000:]},
            artifacts=[r.artifacts[0] for r in subsystem_results if r.artifacts],
        )

        observations = {
            "unity_structure_ok": structure_ok,
            "unity_boot_attempted": boot_attempted,
            "unity_boot_ok": unity_result.passed,
        }

        ended = _utc_now()

        return ProbeReport(
            run_id=run_id,
            started_utc=started,
            ended_utc=ended,
            repo=repo_url,
            requested_commit=commit,
            evidence=evidence,
            observations=observations,
            subsystem_results=subsystem_results,
            metrics={},
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Recovery probe: fresh-clone + structure + boot evidence")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--unity-path", default=os.environ.get("UNITY_PATH"))
    parser.add_argument("--out", default="probe.json")
    args = parser.parse_args()

    report = run_probe(args.repo, args.commit, unity_path=args.unity_path)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(report.to_json())
    print(report.to_json())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Pilot preflight validator — the clearance gate before human participants.

No artifact reaches a human study session without passing this gate.
For batch runs, a single artifact failure blocks the entire batch.

run_preflight(artifact_dir, engine_version) -> PreflightResult
run_preflight_batch(artifact_dirs, engine_version) -> BatchPreflightReport

The validator delegates all cryptographic and mechanical verification to
engine.replay_verifier; its role is to:
  1. Translate VerificationResult codes into human-readable rejection reasons
  2. Enforce the all-or-nothing batch clearance rule
  3. Carry structured metadata (artifact_dir, engine_version) for audit trails

Intentional constraints:
  - cleared_for_study is False if the batch is empty (no artifacts = no study)
  - cleared_for_study is False if any single artifact fails
  - rejection reasons are stable strings; callers may assert on them
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from engine.replay_verifier import VerificationResult, verify_replay_run

_REJECTION_REASONS: dict[VerificationResult, str] = {
    VerificationResult.VERIFIED: (
        "Artifact cleared: engine reconstruction matches archived track"
    ),
    VerificationResult.HASH_FAILURE: (
        "REJECTED: truth track hash mismatch — file content has been altered"
    ),
    VerificationResult.REPLAY_DIVERGED: (
        "REJECTED: engine reconstruction diverges from archived track"
    ),
    VerificationResult.INVALID_ARTIFACT: (
        "REJECTED: artifact bundle is missing required files or is malformed"
    ),
    VerificationResult.SEED_MISMATCH: (
        "REJECTED: seed snapshot hash mismatch — initial state has been altered"
    ),
    VerificationResult.FRAME_ALIGNMENT_FAILURE: (
        "REJECTED: seed and truth track frame indices do not align"
    ),
    VerificationResult.ENGINE_VERSION_FAILURE: (
        "REJECTED: artifact was produced by an incompatible engine version"
    ),
}


@dataclass(frozen=True)
class PreflightResult:
    """Single-artifact preflight outcome.

    Fields
    ------
    artifact_dir        : The bundle directory that was checked.
    passed              : True only for VerificationResult.VERIFIED.
    verification_result : The raw result from verify_replay_run.
    reason              : Human-readable explanation; stable string suitable
                          for log assertions.
    """

    artifact_dir: Path
    passed: bool
    verification_result: VerificationResult
    reason: str


@dataclass(frozen=True)
class BatchPreflightReport:
    """Aggregate outcome for a set of artifacts.

    cleared_for_study is True if and only if:
      - the batch is non-empty, AND
      - every artifact passed preflight.

    Fields
    ------
    engine_version  : The version string checked against every manifest.
    total_artifacts : len(artifact_dirs) passed to run_preflight_batch.
    passed_count    : Number of artifacts with PreflightResult.passed == True.
    failed_count    : Number of artifacts with PreflightResult.passed == False.
    results         : Tuple of PreflightResult, one per input directory,
                      in the same order as the input list.
    cleared_for_study: The definitive gate signal.
    """

    engine_version: str
    total_artifacts: int
    passed_count: int
    failed_count: int
    results: tuple  # tuple[PreflightResult, ...]
    cleared_for_study: bool

    def __post_init__(self) -> None:
        object.__setattr__(self, "results", tuple(self.results))


def run_preflight(
    artifact_dir: Path,
    engine_version: str,
) -> PreflightResult:
    """Validate a single replay bundle and return a structured result.

    Delegates to verify_replay_run; adds a human-readable reason string.
    Engine exceptions propagate loudly — see engine.replay_verifier for policy.
    """
    result = verify_replay_run(artifact_dir, engine_version)
    return PreflightResult(
        artifact_dir=artifact_dir,
        passed=(result == VerificationResult.VERIFIED),
        verification_result=result,
        reason=_REJECTION_REASONS[result],
    )


def run_preflight_batch(
    artifact_dirs: list[Path],
    engine_version: str,
) -> BatchPreflightReport:
    """Validate every artifact in the batch and return aggregate clearance status.

    Artifacts are evaluated in list order.  Evaluation does NOT short-circuit on
    the first failure so every artifact's result is always present in the report.
    """
    results = [run_preflight(d, engine_version) for d in artifact_dirs]
    passed = sum(1 for r in results if r.passed)
    failed = len(results) - passed
    return BatchPreflightReport(
        engine_version=engine_version,
        total_artifacts=len(results),
        passed_count=passed,
        failed_count=failed,
        results=results,
        cleared_for_study=(failed == 0 and len(results) > 0),
    )

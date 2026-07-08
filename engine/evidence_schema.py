"""M4 Part 2 — Evidence schema: signed, content-addressable record linking
DriftVerdict tokens to the observer report that produced them.

EvidenceRecord is the canonical unit of cross-pipeline trust. It carries
no raw game-state vectors — only the reduction pipeline outputs — so it
remains portable across storage backends.

to_canonical_bytes() produces a deterministic UTF-8 encoding suitable for
SHA-256 hashing: all Decimal fields serialised as quoted strings at full
6-place precision, all dict keys sorted, no floating-point intermediaries.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal

from engine.drift_observer import DriftObservationReport
from engine.drift_policy import DriftVerdict


class EvidenceEncoder(json.JSONEncoder):
    """JSON encoder that renders Decimal as a quoted 6-decimal-place string."""

    def default(self, obj: object) -> object:
        if isinstance(obj, Decimal):
            return f"{obj:.6f}"
        return super().default(obj)


def _observation_report_to_dict(report: DriftObservationReport) -> dict:
    obs_list = [
        {
            "frame": o.frame,
            "position_delta_sq": f"{o.position_delta_sq:.6f}",
            "velocity_delta_sq": f"{o.velocity_delta_sq:.6f}",
            "ball_delta_sq": f"{o.ball_delta_sq:.6f}",
            "belief_delta_sq": f"{o.belief_delta_sq:.6f}",
            "threat_delta": f"{o.threat_delta:.6f}",
        }
        for o in report.observations
    ]
    return {
        "frames_compared": report.frames_compared,
        "first_divergence_frame": report.first_divergence_frame,
        "observations": obs_list,
    }


def _verdict_to_dict(verdict: DriftVerdict) -> dict:
    return {
        "classification": verdict.classification,
        "severity": verdict.severity,
        "action": verdict.action,
        "composite_score": f"{verdict.composite_score:.6f}",
    }


@dataclass(frozen=True)
class EvidenceRecord:
    """Immutable cross-pipeline evidence bundle.

    Fields
    ------
    run_id        : UUID identifying the replay run (caller-supplied).
    engine_version: Semantic version string of the engine that produced the run.
    frames_run    : Total frames in the compared replay (mirrors report.frames_compared).
    timestamp     : ISO-8601 UTC string at record creation time.
    observer_report: Full DriftObservationReport from the measurement pass.
    policy_verdict : DriftVerdict from the policy evaluation pass.
    """

    run_id: str
    engine_version: str
    frames_run: int
    timestamp: str
    observer_report: DriftObservationReport
    policy_verdict: DriftVerdict

    def to_canonical_dict(self) -> dict:
        """Return a JSON-serialisable dict with deterministic key ordering."""
        return {
            "engine_version": self.engine_version,
            "frames_run": self.frames_run,
            "observer_report": _observation_report_to_dict(self.observer_report),
            "policy_verdict": _verdict_to_dict(self.policy_verdict),
            "run_id": self.run_id,
            "timestamp": self.timestamp,
        }

    def to_canonical_bytes(self) -> bytes:
        """UTF-8 encoding of sorted-key JSON; suitable for SHA-256 hashing."""
        return json.dumps(
            self.to_canonical_dict(), sort_keys=True, separators=(",", ":")
        ).encode("utf-8")

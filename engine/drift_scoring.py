"""Pure drift scoring.

Turns raw structural/asset metrics into a weighted drift score and a
classification band. No I/O, no filesystem, no git — a function of its
inputs only, so it stays trivially testable and replayable.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass

THRESHOLDS = {
    "MINOR": 0.15,
    "MAJOR": 0.40,
    "CRITICAL": 0.70,
}

WEIGHTS = {
    "asset_entropy": 0.25,
    "reference_integrity_loss": 0.35,
    "scene_instability": 0.25,
    "dependency_graph_fragmentation": 0.15,
}


@dataclass(frozen=True)
class DriftMetrics:
    asset_entropy: float = 0.0
    reference_integrity_loss: float = 0.0
    scene_instability: float = 0.0
    dependency_graph_fragmentation: float = 0.0

    def as_breakdown(self) -> dict[str, float]:
        return {
            "asset_entropy": self.asset_entropy,
            "reference_integrity_loss": self.reference_integrity_loss,
            "scene_instability": self.scene_instability,
            "dependency_graph_fragmentation": self.dependency_graph_fragmentation,
        }


def known_metric_fields() -> set[str]:
    return {f.name for f in dataclasses.fields(DriftMetrics)}


def classify(total: float) -> str:
    if total >= THRESHOLDS["CRITICAL"]:
        return "CRITICAL"
    if total >= THRESHOLDS["MAJOR"]:
        return "MAJOR"
    if total >= THRESHOLDS["MINOR"]:
        return "MINOR"
    return "STABLE"


def compute_drift_score(metrics: DriftMetrics) -> dict:
    breakdown = metrics.as_breakdown()
    total = sum(breakdown[k] * WEIGHTS[k] for k in WEIGHTS)
    total = round(min(max(total, 0.0), 1.0), 4)
    return {
        "total": total,
        "classification": classify(total),
        "breakdown": breakdown,
        "raw_vector": [breakdown[k] for k in WEIGHTS],
    }

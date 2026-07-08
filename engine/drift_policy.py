"""M4 Drift Policy — pure threshold mapper from DriftScore to operational verdict.

evaluate_drift_policy(score) -> DriftVerdict

Strictly forbidden from inspecting raw game state, spatial vectors, or
DriftObservation records. Reads only the composite_score from DriftScore.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from engine.track_scorer import DriftScore

WARNING_THRESHOLD = Decimal("0.010000")
FAILURE_THRESHOLD = Decimal("1.000000")


@dataclass(frozen=True)
class DriftVerdict:
    classification: str
    severity: str
    action: str
    composite_score: Decimal


def evaluate_drift_policy(score: DriftScore) -> DriftVerdict:
    comp = score.composite_score

    if comp == Decimal("0"):
        return DriftVerdict(
            classification="IDENTICAL_TRACKS",
            severity="NONE",
            action="CONTINUE",
            composite_score=comp,
        )
    if comp <= WARNING_THRESHOLD:
        return DriftVerdict(
            classification="SOFT_DESYNC_RECOVERABLE",
            severity="WARNING",
            action="REPLAY_FROM_CHECKPOINT",
            composite_score=comp,
        )
    if comp < FAILURE_THRESHOLD:
        return DriftVerdict(
            classification="BELIEF_STATE_DIVERGENCE",
            severity="CRITICAL",
            action="FLAG_FOR_REVIEW",
            composite_score=comp,
        )
    return DriftVerdict(
        classification="KINEMATIC_DIVERGENCE",
        severity="FATAL",
        action="INVALIDATE_RUN",
        composite_score=comp,
    )

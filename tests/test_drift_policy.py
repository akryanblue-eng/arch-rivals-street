"""M4 — Drift policy: threshold boundaries, classification labels, action tokens."""

from __future__ import annotations

from decimal import Decimal

import pytest

from engine.drift_policy import (
    FAILURE_THRESHOLD,
    WARNING_THRESHOLD,
    DriftVerdict,
    evaluate_drift_policy,
)
from engine.track_scorer import DriftScore

# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

_ZERO = Decimal("0.000000")


def _score(composite: str) -> DriftScore:
    return DriftScore(
        frames_compared=1,
        position_total=_ZERO,   position_average=_ZERO,
        velocity_total=_ZERO,   velocity_average=_ZERO,
        ball_total=_ZERO,       ball_average=_ZERO,
        belief_total=_ZERO,     belief_average=_ZERO,
        threat_total=_ZERO,     threat_average=_ZERO,
        composite_score=Decimal(composite),
    )


# ---------------------------------------------------------------------------
# 1. Classification correctness at boundaries
# ---------------------------------------------------------------------------


def test_exact_zero_is_identical_tracks():
    verdict = evaluate_drift_policy(_score("0.000000"))
    assert verdict.classification == "IDENTICAL_TRACKS"
    assert verdict.severity == "NONE"
    assert verdict.action == "CONTINUE"


def test_just_above_zero_is_soft_desync():
    verdict = evaluate_drift_policy(_score("0.000001"))
    assert verdict.classification == "SOFT_DESYNC_RECOVERABLE"
    assert verdict.action == "REPLAY_FROM_CHECKPOINT"


def test_exactly_at_warning_threshold_is_soft_desync():
    verdict = evaluate_drift_policy(_score(str(WARNING_THRESHOLD)))
    assert verdict.classification == "SOFT_DESYNC_RECOVERABLE"


def test_just_above_warning_threshold_is_belief_state_divergence():
    above = WARNING_THRESHOLD + Decimal("0.000001")
    verdict = evaluate_drift_policy(_score(str(above)))
    assert verdict.classification == "BELIEF_STATE_DIVERGENCE"
    assert verdict.severity == "CRITICAL"
    assert verdict.action == "FLAG_FOR_REVIEW"


def test_mid_range_is_belief_state_divergence():
    verdict = evaluate_drift_policy(_score("0.500000"))
    assert verdict.classification == "BELIEF_STATE_DIVERGENCE"


def test_just_below_failure_threshold_is_belief_state_divergence():
    below = FAILURE_THRESHOLD - Decimal("0.000001")
    verdict = evaluate_drift_policy(_score(str(below)))
    assert verdict.classification == "BELIEF_STATE_DIVERGENCE"


def test_exactly_at_failure_threshold_is_kinematic_divergence():
    verdict = evaluate_drift_policy(_score(str(FAILURE_THRESHOLD)))
    assert verdict.classification == "KINEMATIC_DIVERGENCE"
    assert verdict.severity == "FATAL"
    assert verdict.action == "INVALIDATE_RUN"


def test_far_above_failure_threshold_is_kinematic_divergence():
    verdict = evaluate_drift_policy(_score("100.000000"))
    assert verdict.classification == "KINEMATIC_DIVERGENCE"
    assert verdict.action == "INVALIDATE_RUN"


# ---------------------------------------------------------------------------
# 2. Half-threshold value is soft desync
# ---------------------------------------------------------------------------


def test_half_warning_threshold_is_soft_desync():
    half = WARNING_THRESHOLD / 2
    verdict = evaluate_drift_policy(_score(str(half)))
    assert verdict.classification == "SOFT_DESYNC_RECOVERABLE"


# ---------------------------------------------------------------------------
# 3. Composite score is preserved in verdict
# ---------------------------------------------------------------------------


def test_verdict_carries_composite_score():
    comp = Decimal("0.050000")
    verdict = evaluate_drift_policy(_score(str(comp)))
    assert verdict.composite_score == comp


def test_zero_composite_preserved_in_verdict():
    verdict = evaluate_drift_policy(_score("0.000000"))
    assert verdict.composite_score == Decimal("0")


# ---------------------------------------------------------------------------
# 4. Verdict is immutable
# ---------------------------------------------------------------------------


def test_verdict_is_frozen():
    verdict = evaluate_drift_policy(_score("0.0"))
    with pytest.raises((AttributeError, TypeError)):
        verdict.classification = "HACKED"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# 5. Policy reads only composite_score, not raw game state
# ---------------------------------------------------------------------------


def test_policy_does_not_accept_game_snapshot_directly():
    """Structural: the function signature takes DriftScore, not GameSnapshot."""
    import inspect
    sig = inspect.signature(evaluate_drift_policy)
    params = list(sig.parameters.keys())
    assert params == ["score"]


@pytest.mark.parametrize("comp,expected_class", [
    ("0.000000", "IDENTICAL_TRACKS"),
    ("0.005000", "SOFT_DESYNC_RECOVERABLE"),
    ("0.010000", "SOFT_DESYNC_RECOVERABLE"),
    ("0.010001", "BELIEF_STATE_DIVERGENCE"),
    ("0.999999", "BELIEF_STATE_DIVERGENCE"),
    ("1.000000", "KINEMATIC_DIVERGENCE"),
    ("1.000001", "KINEMATIC_DIVERGENCE"),
])
def test_classification_matrix(comp, expected_class):
    verdict = evaluate_drift_policy(_score(comp))
    assert verdict.classification == expected_class

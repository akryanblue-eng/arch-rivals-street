"""M3.1 — Track scorer: normalization parity, channel isolation, determinism."""

from __future__ import annotations

from decimal import Decimal

import pytest

from engine.config.drift_weights import DEFAULT_DRIFT_WEIGHTS
from engine.drift_observer import DriftObservation, DriftObservationReport
from engine.track_scorer import DriftScore, calculate_drift_score

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_ZERO = Decimal("0.000000")


def _obs(frame: int = 1, pos: str = "0.0", vel: str = "0.0",
         ball: str = "0.0", belief: str = "0.0", threat: str = "0.0") -> DriftObservation:
    return DriftObservation(
        frame=frame,
        position_delta_sq=Decimal(pos),
        velocity_delta_sq=Decimal(vel),
        ball_delta_sq=Decimal(ball),
        belief_delta_sq=Decimal(belief),
        threat_delta=Decimal(threat),
    )


def _report(observations: list[DriftObservation],
            first: int | None = None) -> DriftObservationReport:
    return DriftObservationReport(
        frames_compared=len(observations),
        first_divergence_frame=first,
        observations=observations,
    )


@pytest.fixture
def weights():
    return dict(DEFAULT_DRIFT_WEIGHTS)


# ---------------------------------------------------------------------------
# 1. Zero-delta input → zero composite
# ---------------------------------------------------------------------------


def test_identical_observations_zero_composite(weights):
    report = _report([_obs()])
    score = calculate_drift_score(report, weights)
    assert score.composite_score == _ZERO
    assert score.position_average == _ZERO


def test_empty_report_returns_zero_score(weights):
    report = DriftObservationReport(frames_compared=0, first_divergence_frame=None, observations=[])
    score = calculate_drift_score(report, weights)
    assert score.composite_score == _ZERO
    assert score.frames_compared == 0


# ---------------------------------------------------------------------------
# 2. Single-channel mutation
# ---------------------------------------------------------------------------


def test_position_only_mutation_isolates_to_position(weights):
    report = _report([_obs(pos="2.500000")])
    score = calculate_drift_score(report, weights)
    # pos_average = 2.5; composite = 2.5 * 0.4 = 1.0; all others zero
    assert score.position_average == Decimal("2.5")
    assert score.velocity_average == _ZERO
    assert score.ball_average == _ZERO
    assert score.belief_average == _ZERO
    assert score.threat_average == _ZERO
    assert score.composite_score == Decimal("2.5") * weights["position"]


def test_threat_only_mutation_isolates_to_threat(weights):
    report = _report([_obs(threat="0.400000")])
    score = calculate_drift_score(report, weights)
    assert score.threat_average == Decimal("0.4")
    assert score.position_average == _ZERO
    expected = Decimal("0.4") * weights["threat"]
    assert score.composite_score == expected


def test_ball_only_mutation_isolates_to_ball(weights):
    report = _report([_obs(ball="1.000000")])
    score = calculate_drift_score(report, weights)
    assert score.ball_average == Decimal("1.0")
    assert score.composite_score == Decimal("1.0") * weights["ball"]


# ---------------------------------------------------------------------------
# 3. Length-invariant normalization (M3.1 key property)
# ---------------------------------------------------------------------------


def test_long_replay_normalization_parity(weights):
    """Average score is identical for short and long replays with the same per-frame delta."""
    same_obs = _obs(pos="2.000000")

    short = DriftObservationReport(
        frames_compared=10, first_divergence_frame=1, observations=[same_obs] * 10
    )
    long = DriftObservationReport(
        frames_compared=100, first_divergence_frame=1, observations=[same_obs] * 100
    )

    short_score = calculate_drift_score(short, weights)
    long_score = calculate_drift_score(long, weights)

    assert short_score.position_average == long_score.position_average
    assert short_score.composite_score == long_score.composite_score
    # totals must differ by a factor of 10
    assert long_score.position_total == short_score.position_total * 10


def test_single_frame_average_equals_total(weights):
    report = _report([_obs(pos="3.000000")])
    score = calculate_drift_score(report, weights)
    assert score.position_average == score.position_total


# ---------------------------------------------------------------------------
# 4. Aggregation order invariance
# ---------------------------------------------------------------------------


def test_aggregation_order_does_not_affect_composite(weights):
    o1 = _obs(frame=1, pos="1.000000")
    o2 = _obs(frame=2, pos="2.000000")

    fwd = calculate_drift_score(_report([o1, o2], first=1), weights)
    rev = calculate_drift_score(_report([o2, o1], first=1), weights)

    assert fwd.composite_score == rev.composite_score
    # pos_average = (1+2)/2 = 1.5; composite = 1.5 * 0.4 = 0.6
    assert fwd.composite_score == Decimal("1.5") * weights["position"]


# ---------------------------------------------------------------------------
# 5. Missing weight key fails loudly
# ---------------------------------------------------------------------------


def test_missing_weight_key_raises_key_error():
    incomplete = {"position": Decimal("0.5")}
    report = _report([])
    with pytest.raises(KeyError, match="Missing critical weight parameters"):
        calculate_drift_score(report, incomplete)


def test_all_five_weight_keys_are_required():
    for drop_key in ("position", "velocity", "ball", "belief", "threat"):
        partial = {k: v for k, v in DEFAULT_DRIFT_WEIGHTS.items() if k != drop_key}
        with pytest.raises(KeyError):
            calculate_drift_score(_report([]), partial)


# ---------------------------------------------------------------------------
# 6. Weight substitution changes score but not observations
# ---------------------------------------------------------------------------


def test_weight_change_alters_composite_not_observations(weights):
    report = _report([_obs(pos="2.000000")])
    score_a = calculate_drift_score(report, weights)

    heavy_weights = dict(weights)
    heavy_weights["position"] = Decimal("0.900000")
    score_b = calculate_drift_score(report, heavy_weights)

    # Observations are unchanged (same report used)
    assert score_a.position_average == score_b.position_average
    # Composite must differ
    assert score_a.composite_score != score_b.composite_score
    assert score_b.composite_score > score_a.composite_score


# ---------------------------------------------------------------------------
# 7. Schema fields
# ---------------------------------------------------------------------------


def test_drift_score_exposes_all_required_fields(weights):
    score = calculate_drift_score(_report([_obs()]), weights)
    required = {
        "frames_compared",
        "position_total", "position_average",
        "velocity_total", "velocity_average",
        "ball_total", "ball_average",
        "belief_total", "belief_average",
        "threat_total", "threat_average",
        "composite_score",
    }
    assert required.issubset(score.__dict__.keys())


def test_frames_compared_is_preserved(weights):
    obs_list = [_obs(frame=i) for i in range(7)]
    report = DriftObservationReport(
        frames_compared=7, first_divergence_frame=None, observations=obs_list
    )
    score = calculate_drift_score(report, weights)
    assert score.frames_compared == 7

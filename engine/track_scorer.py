"""M3.1 Game-track drift scorer — pure arithmetic reduction of observation reports.

calculate_drift_score(report, weights) -> DriftScore

Consumes a DriftObservationReport and reduces it to per-channel totals,
per-channel averages (length-invariant), and a weighted composite score
derived from the averages. No game-state imports, no thresholds, no policy.

Naming: this module is intentionally separate from engine/drift_scoring.py,
which scores Unity project recoverability metrics (DriftMetrics). These are
different pipelines with different contracts.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from engine.drift_observer import DriftObservationReport

_REQUIRED_KEYS = frozenset({"position", "velocity", "ball", "belief", "threat"})


@dataclass(frozen=True)
class DriftScore:
    """Immutable per-channel and composite measurement indices.

    *_total  — sum of all frame deltas (accumulation; sensitive to replay length)
    *_average — total / frames_compared (length-invariant; comparable across runs)
    composite_score — weighted sum of channel averages
    """
    frames_compared: int
    position_total: Decimal
    position_average: Decimal
    velocity_total: Decimal
    velocity_average: Decimal
    ball_total: Decimal
    ball_average: Decimal
    belief_total: Decimal
    belief_average: Decimal
    threat_total: Decimal
    threat_average: Decimal
    composite_score: Decimal


def calculate_drift_score(
    report: DriftObservationReport,
    weights: dict[str, Decimal],
) -> DriftScore:
    """Reduce a DriftObservationReport to normalized DriftScore metrics.

    Raises:
        KeyError: if any required weight key is absent.
    """
    missing = _REQUIRED_KEYS - weights.keys()
    if missing:
        raise KeyError(
            f"Configuration Failure: Missing critical weight parameters for calculations: {missing}"
        )

    frames = report.frames_compared
    _ZERO = Decimal("0.000000")

    if frames == 0 or not report.observations:
        return DriftScore(
            frames_compared=0,
            position_total=_ZERO, position_average=_ZERO,
            velocity_total=_ZERO, velocity_average=_ZERO,
            ball_total=_ZERO,     ball_average=_ZERO,
            belief_total=_ZERO,   belief_average=_ZERO,
            threat_total=_ZERO,   threat_average=_ZERO,
            composite_score=_ZERO,
        )

    pos_t  = sum(o.position_delta_sq  for o in report.observations)
    vel_t  = sum(o.velocity_delta_sq  for o in report.observations)
    ball_t = sum(o.ball_delta_sq      for o in report.observations)
    bel_t  = sum(o.belief_delta_sq    for o in report.observations)
    thr_t  = sum(o.threat_delta       for o in report.observations)

    fd = Decimal(frames)
    pos_a  = pos_t  / fd
    vel_a  = vel_t  / fd
    ball_a = ball_t / fd
    bel_a  = bel_t  / fd
    thr_a  = thr_t  / fd

    composite = (
        pos_a  * weights["position"]
        + vel_a  * weights["velocity"]
        + ball_a * weights["ball"]
        + bel_a  * weights["belief"]
        + thr_a  * weights["threat"]
    )

    return DriftScore(
        frames_compared=frames,
        position_total=pos_t,   position_average=pos_a,
        velocity_total=vel_t,   velocity_average=vel_a,
        ball_total=ball_t,      ball_average=ball_a,
        belief_total=bel_t,     belief_average=bel_a,
        threat_total=thr_t,     threat_average=thr_a,
        composite_score=composite,
    )

"""Blind track-comparison instrument — the lowest-privilege analytical component.

observe_tracks(reference, candidate) -> DriftObservationReport

Pure measurement: computes frame-by-frame spatial and belief deltas between
two GameSnapshot sequences. No thresholds, no severity, no policy, no imports
from drift_policy, drift_scoring, human_study, or gameplay constants.

Raises ValueError on structural misalignment (length mismatch, frame-ID
mismatch) so the caller knows the comparison is geometrically invalid before
any delta is interpreted.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from engine.game_state import GameSnapshot

_ZERO = Decimal("0")


@dataclass(frozen=True)
class DriftObservation:
    """Immutable per-frame delta snapshot. All values are non-negative."""
    frame: int
    position_delta_sq: Decimal   # attacker + defender combined position Δ²
    velocity_delta_sq: Decimal   # attacker + defender combined velocity Δ²
    ball_delta_sq: Decimal       # ball position Δ²
    belief_delta_sq: Decimal     # defender predicted-intercept Δ²
    threat_delta: Decimal        # |ref.threat_level - cand.threat_level|


@dataclass(frozen=True)
class DriftObservationReport:
    frames_compared: int
    first_divergence_frame: int | None
    observations: tuple          # tuple[DriftObservation, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "observations", tuple(self.observations))


def observe_tracks(
    reference_track: list[GameSnapshot],
    candidate_track: list[GameSnapshot],
) -> DriftObservationReport:
    """Frame-by-frame differential analysis between two tracks.

    Raises:
        ValueError: track lengths differ, or frame indices do not align.
    """
    if len(reference_track) != len(candidate_track):
        raise ValueError(
            f"Structural Alignment Failure: Track lengths do not match. "
            f"Reference: {len(reference_track)}, Candidate: {len(candidate_track)}"
        )

    observations: list[DriftObservation] = []
    first_divergence_frame: int | None = None

    for ref, cand in zip(reference_track, candidate_track):
        if ref.frame != cand.frame:
            raise ValueError(
                f"Frame Alignment Failure: Timeline identity mismatch. "
                f"Reference frame {ref.frame} mapped to candidate frame {cand.frame}."
            )

        # Position delta² (attacker + defender combined)
        ax = ref.attacker.kinematics.position.x - cand.attacker.kinematics.position.x
        ay = ref.attacker.kinematics.position.y - cand.attacker.kinematics.position.y
        dx = ref.defender.kinematics.position.x - cand.defender.kinematics.position.x
        dy = ref.defender.kinematics.position.y - cand.defender.kinematics.position.y
        pos_delta_sq = ax * ax + ay * ay + dx * dx + dy * dy

        # Velocity delta² (attacker + defender combined)
        avx = ref.attacker.kinematics.velocity.x - cand.attacker.kinematics.velocity.x
        avy = ref.attacker.kinematics.velocity.y - cand.attacker.kinematics.velocity.y
        dvx = ref.defender.kinematics.velocity.x - cand.defender.kinematics.velocity.x
        dvy = ref.defender.kinematics.velocity.y - cand.defender.kinematics.velocity.y
        vel_delta_sq = avx * avx + avy * avy + dvx * dvx + dvy * dvy

        # Ball position delta²
        bx = ref.ball.position.x - cand.ball.position.x
        by = ref.ball.position.y - cand.ball.position.y
        ball_delta_sq = bx * bx + by * by

        # Defender belief intercept delta²
        bix = ref.defender.belief.predicted_intercept.x - cand.defender.belief.predicted_intercept.x
        biy = ref.defender.belief.predicted_intercept.y - cand.defender.belief.predicted_intercept.y
        belief_delta_sq = bix * bix + biy * biy

        # Threat level absolute delta
        threat_delta = abs(ref.defender.belief.threat_level - cand.defender.belief.threat_level)

        has_diverged = (
            pos_delta_sq != _ZERO
            or vel_delta_sq != _ZERO
            or ball_delta_sq != _ZERO
            or belief_delta_sq != _ZERO
            or threat_delta != _ZERO
        )
        if has_diverged and first_divergence_frame is None:
            first_divergence_frame = ref.frame

        observations.append(
            DriftObservation(
                frame=ref.frame,
                position_delta_sq=pos_delta_sq,
                velocity_delta_sq=vel_delta_sq,
                ball_delta_sq=ball_delta_sq,
                belief_delta_sq=belief_delta_sq,
                threat_delta=threat_delta,
            )
        )

    return DriftObservationReport(
        frames_compared=len(reference_track),
        first_divergence_frame=first_divergence_frame,
        observations=observations,
    )

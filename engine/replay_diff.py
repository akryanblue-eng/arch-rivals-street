"""M5 — Replay diff: channel-level divergence diagnostics.

compute_replay_diff(reference, candidate) -> DivergenceDiagnostic

Wraps observe_tracks and extracts the peak delta per channel, giving a
single-frame summary of where two timelines diverged and by how much.

This powers the research question:
    "The player felt the defender cheated — was it physics, belief-state,
     ball trajectory, or perception mismatch?"
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from engine.drift_observer import observe_tracks
from engine.game_state import GameSnapshot

_ZERO = Decimal("0.000000")


@dataclass(frozen=True)
class DivergenceDiagnostic:
    """Peak per-channel divergence between two tracks.

    All *_max fields are the maximum observed squared-distance (or absolute
    delta for threat) across all compared frames.  They are zero when the
    tracks are identical.
    """

    first_divergence_frame: int | None
    position_delta_max: Decimal   # max position_delta_sq across all frames
    velocity_delta_max: Decimal   # max velocity_delta_sq across all frames
    ball_delta_max: Decimal       # max ball_delta_sq across all frames
    belief_delta_max: Decimal     # max belief_delta_sq across all frames
    threat_delta_max: Decimal     # max threat_delta across all frames


def compute_replay_diff(
    reference: list[GameSnapshot],
    candidate: list[GameSnapshot],
) -> DivergenceDiagnostic:
    """Compute per-channel peak deltas between two GameSnapshot tracks.

    Delegates structural validation to observe_tracks (raises ValueError on
    length or frame-ID mismatch).  Returns an all-zero diagnostic for empty
    tracks or perfectly identical tracks.
    """
    report = observe_tracks(reference, candidate)

    if not report.observations:
        return DivergenceDiagnostic(
            first_divergence_frame=None,
            position_delta_max=_ZERO,
            velocity_delta_max=_ZERO,
            ball_delta_max=_ZERO,
            belief_delta_max=_ZERO,
            threat_delta_max=_ZERO,
        )

    return DivergenceDiagnostic(
        first_divergence_frame=report.first_divergence_frame,
        position_delta_max=max(o.position_delta_sq for o in report.observations),
        velocity_delta_max=max(o.velocity_delta_sq for o in report.observations),
        ball_delta_max=max(o.ball_delta_sq for o in report.observations),
        belief_delta_max=max(o.belief_delta_sq for o in report.observations),
        threat_delta_max=max(o.threat_delta for o in report.observations),
    )

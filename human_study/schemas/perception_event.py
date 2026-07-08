"""Wire schema for a single participant observation token.

Carries only what a human observer can see and report. Machine fields
(drift_report, classification, artifact_hash, engine_version, frames_run)
are structurally excluded: this dataclass has no fields for them.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PerceptionEvent:
    artifact_id: str
    participant_id: str
    question_id: str
    response_value: str
    response_time_ms: int

    def to_dict(self) -> dict:
        return {
            "artifact_id": self.artifact_id,
            "participant_id": self.participant_id,
            "question_id": self.question_id,
            "response_value": self.response_value,
            "response_time_ms": self.response_time_ms,
        }

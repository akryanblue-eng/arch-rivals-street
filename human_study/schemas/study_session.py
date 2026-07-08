"""Immutable session envelope holding all events from a single participant run."""

from __future__ import annotations

import json
from dataclasses import dataclass

from human_study.schemas.perception_event import PerceptionEvent


@dataclass(frozen=True)
class StudySession:
    session_id: str
    participant_id: str
    artifact_ids: tuple
    events: tuple
    protocol_version: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "artifact_ids", tuple(self.artifact_ids))
        object.__setattr__(self, "events", tuple(self.events))

    def serialize_session(self) -> str:
        return json.dumps(
            {
                "session_id": self.session_id,
                "participant_id": self.participant_id,
                "artifact_ids": list(self.artifact_ids),
                "protocol_version": self.protocol_version,
                "events": [e.to_dict() for e in self.events],
            },
            sort_keys=True,
            indent=2,
        )

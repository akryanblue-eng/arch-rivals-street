"""Boundary adapter: raw wire dict → validated PerceptionEvent.

Enforces three guards in order:
1. Structural contamination guard — no machine evidence keys allowed.
2. Type coercion — missing/wrong-typed fields raise ValueError.
3. Protocol schema guard — delegates to validate_event_against_protocol.
"""

from __future__ import annotations

from human_study.schemas.perception_event import PerceptionEvent
from human_study.validation.response_constraints import (
    ProtocolViolationError,
    validate_event_against_protocol,
)

_FORBIDDEN_KEYS = frozenset({
    "drift_report",
    "classification",
    "engine_version",
    "frames_run",
    "artifact_hash",
    "verdict",
    "status",
})


def import_external_event_payload(raw_dict: dict, participant_id: str) -> PerceptionEvent:
    if any(key in raw_dict for key in _FORBIDDEN_KEYS):
        raise ValueError(
            "Payload contamination detected: Machine evidence keys are forbidden in human telemetry."
        )

    try:
        event = PerceptionEvent(
            artifact_id=str(raw_dict["artifact_id"]),
            participant_id=str(participant_id),
            question_id=str(raw_dict["question_id"]),
            response_value=str(raw_dict["response_value"]),
            response_time_ms=int(raw_dict["response_time_ms"]),
        )
    except KeyError as e:
        raise ValueError(f"Missing required response field at boundary: {e}") from e
    except (TypeError, ValueError) as e:
        raise ValueError(f"Type conversion failure inside adapter frame: {e}") from e

    validate_event_against_protocol(event)
    return event

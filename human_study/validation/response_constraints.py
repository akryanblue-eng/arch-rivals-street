"""Protocol boundary enforcer.

Validates that a PerceptionEvent's response value is within the
frozen domain specified by QSO-PROJECT-002-L3-human-perception-protocol v1.0.0.
"""

from __future__ import annotations

from human_study.schemas.perception_event import PerceptionEvent

VALID_RESPONSES: dict[str, set[str]] = {
    "KP-01": {"YES", "NO", "UNSURE"},
    "KP-02": {"PREMATURE", "APPROPRIATE", "LATE"},
    "KP-03": {"1", "2", "3", "4", "5"},
    "AP-01": {"DELIBERATE", "ERRATIC", "UNSURE"},
    "AP-02": {"ADAPTIVE", "STATIC", "RANDOM"},
    "AP-03": {"CAUSAL", "ACCIDENTAL", "UNSURE"},
}


class ProtocolViolationError(ValueError):
    """Raised when an external human payload breaks protocol v1.0.0 boundaries."""


def validate_event_against_protocol(event: PerceptionEvent) -> None:
    if event.question_id not in VALID_RESPONSES:
        raise ProtocolViolationError(
            f"Question identifier '{event.question_id}' not found in protocol v1.0.0."
        )
    if event.response_value not in VALID_RESPONSES[event.question_id]:
        raise ProtocolViolationError(
            f"Invalid response '{event.response_value}' for question '{event.question_id}'. "
            f"Allowed values: {VALID_RESPONSES[event.question_id]}"
        )

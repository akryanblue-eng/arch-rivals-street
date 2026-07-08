"""Session orchestrator: assembles a validated StudySession from raw participant responses.

The runner knows nothing about defenders, drift, or replay correctness.
It only enforces artifact-scope containment and delegates all wire validation
to the importer.
"""

from __future__ import annotations

from human_study.ingestion.response_importer import import_external_event_payload
from human_study.schemas.study_session import StudySession


def create_session(
    session_id: str,
    participant_id: str,
    artifact_ids: list[str],
    raw_responses: list[dict],
) -> StudySession:
    events = []
    for payload in raw_responses:
        if payload.get("artifact_id") not in artifact_ids:
            raise ValueError(
                f"Security Fault: Response context references artifact "
                f"'{payload.get('artifact_id')}' which is outside this session's "
                f"authorized bounds: {artifact_ids}"
            )
        event = import_external_event_payload(payload, participant_id=participant_id)
        events.append(event)

    return StudySession(
        session_id=session_id,
        participant_id=participant_id,
        artifact_ids=artifact_ids,
        events=events,
        protocol_version="1.0.0",
    )

"""L3.3 — Boundary adapter tests: contamination guard, protocol enforcement."""

import pytest

from human_study.ingestion.response_importer import import_external_event_payload
from human_study.validation.response_constraints import ProtocolViolationError

_CLEAN_PAYLOAD = {
    "artifact_id": "artifact-uuid-099",
    "question_id": "KP-02",
    "response_value": "LATE",
    "response_time_ms": 1150,
}


def test_clean_payload_import_matches_contract():
    event = import_external_event_payload(_CLEAN_PAYLOAD, participant_id="anon-user-x")
    assert event.artifact_id == "artifact-uuid-099"
    assert event.question_id == "KP-02"
    assert event.response_value == "LATE"
    assert event.response_time_ms == 1150


def test_importer_sets_participant_id_from_argument():
    event = import_external_event_payload(_CLEAN_PAYLOAD, participant_id="p-42")
    assert event.participant_id == "p-42"


def test_importer_explicitly_rejects_machine_contamination():
    contaminated = {**_CLEAN_PAYLOAD, "classification": "KINEMATIC_DIVERGENCE"}
    with pytest.raises(ValueError, match="Payload contamination detected"):
        import_external_event_payload(contaminated, participant_id="anon-user-x")


@pytest.mark.parametrize("forbidden_key", [
    "drift_report", "classification", "engine_version",
    "frames_run", "artifact_hash", "verdict", "status",
])
def test_all_forbidden_keys_are_rejected(forbidden_key):
    payload = {**_CLEAN_PAYLOAD, forbidden_key: "any_value"}
    with pytest.raises(ValueError, match="Payload contamination detected"):
        import_external_event_payload(payload, participant_id="p")


def test_importer_enforces_protocol_value_boundaries():
    bad_value = {**_CLEAN_PAYLOAD, "response_value": "TOTALLY_BROKEN_VAL"}
    with pytest.raises(ProtocolViolationError, match="Invalid response"):
        import_external_event_payload(bad_value, participant_id="anon-user-x")


def test_importer_rejects_unknown_question_id():
    bad_q = {**_CLEAN_PAYLOAD, "question_id": "ZZ-99"}
    with pytest.raises(ProtocolViolationError, match="not found in protocol"):
        import_external_event_payload(bad_q, participant_id="p")


def test_importer_raises_value_error_on_missing_field():
    incomplete = {"artifact_id": "x", "question_id": "KP-01", "response_value": "YES"}
    with pytest.raises(ValueError, match="Missing required response field"):
        import_external_event_payload(incomplete, participant_id="p")


def test_importer_accepts_all_valid_kp01_responses():
    for val in ("YES", "NO", "UNSURE"):
        payload = {**_CLEAN_PAYLOAD, "question_id": "KP-01", "response_value": val}
        event = import_external_event_payload(payload, participant_id="p")
        assert event.response_value == val


def test_importer_accepts_all_valid_ap02_responses():
    for val in ("ADAPTIVE", "STATIC", "RANDOM"):
        payload = {**_CLEAN_PAYLOAD, "question_id": "AP-02", "response_value": val}
        event = import_external_event_payload(payload, participant_id="p")
        assert event.response_value == val

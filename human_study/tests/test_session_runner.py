"""L3.4 — Session runner and question-flow invariant tests."""

import pytest

from human_study.capture.question_flow import calculate_question_set_hash, get_protocol_questions
from human_study.capture.session_runner import create_session
from human_study.validation.response_constraints import ProtocolViolationError

_ARTIFACT_IDS = ["art-001", "art-002"]

_RAW_RESPONSES = [
    {"artifact_id": "art-001", "question_id": "KP-02", "response_value": "APPROPRIATE", "response_time_ms": 1200},
    {"artifact_id": "art-002", "question_id": "AP-02", "response_value": "ADAPTIVE", "response_time_ms": 950},
]


def test_valid_session_assembly():
    session = create_session(
        session_id="pilot-001",
        participant_id="anon-001",
        artifact_ids=_ARTIFACT_IDS,
        raw_responses=_RAW_RESPONSES,
    )
    assert session.session_id == "pilot-001"
    assert len(session.events) == 2
    assert session.protocol_version == "1.0.0"


def test_session_participant_id_is_set():
    session = create_session("s", "anon-x", _ARTIFACT_IDS, _RAW_RESPONSES)
    assert session.participant_id == "anon-x"


def test_session_artifact_ids_are_stored():
    session = create_session("s", "p", _ARTIFACT_IDS, _RAW_RESPONSES)
    assert "art-001" in session.artifact_ids
    assert "art-002" in session.artifact_ids


def test_session_runner_rejects_unauthorized_artifact_ids():
    unauthorized = [
        {"artifact_id": "art-MALICIOUS", "question_id": "KP-02",
         "response_value": "APPROPRIATE", "response_time_ms": 1200},
    ]
    with pytest.raises(ValueError, match="outside this session's authorized bounds"):
        create_session("pilot-001", "anon-001", ["art-001"], unauthorized)


def test_session_runner_propagates_protocol_violation():
    bad_response = [
        {"artifact_id": "art-001", "question_id": "KP-02",
         "response_value": "INVALID_TOKEN", "response_time_ms": 500},
    ]
    with pytest.raises(ProtocolViolationError):
        create_session("s", "p", ["art-001"], bad_response)


def test_session_runner_propagates_contamination_rejection():
    contaminated = [
        {"artifact_id": "art-001", "question_id": "KP-01", "response_value": "YES",
         "response_time_ms": 400, "engine_version": "0.0.1"},
    ]
    with pytest.raises(ValueError, match="Payload contamination detected"):
        create_session("s", "p", ["art-001"], contaminated)


def test_empty_response_list_creates_empty_session():
    session = create_session("s", "p", [], [])
    assert len(session.events) == 0


def test_question_set_hash_invariance():
    h1 = calculate_question_set_hash()
    h2 = calculate_question_set_hash()
    assert h1 == h2
    assert len(h1) == 64


def test_get_protocol_questions_returns_all_six():
    qs = get_protocol_questions()
    assert qs == ["KP-01", "KP-02", "KP-03", "AP-01", "AP-02", "AP-03"]


def test_get_protocol_questions_returns_new_list_each_call():
    a = get_protocol_questions()
    b = get_protocol_questions()
    assert a == b
    assert a is not b

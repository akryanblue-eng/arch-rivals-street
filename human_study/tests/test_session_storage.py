"""L3.4 — Session storage serialization loop tests."""

import json
import shutil
from pathlib import Path

from human_study.capture.session_runner import create_session
from human_study.storage.session_writer import write_session

_TMP = Path("artifacts/test_human_study_output")


def _cleanup():
    if _TMP.exists():
        shutil.rmtree(_TMP)


def test_session_writer_serialization_loop():
    _cleanup()
    raw_responses = [
        {"artifact_id": "art-001", "question_id": "KP-01",
         "response_value": "YES", "response_time_ms": 800},
    ]
    session = create_session("pilot-write-test", "anon-002", ["art-001"], raw_responses)

    written_path = write_session(session, custom_root=_TMP)
    assert written_path.exists()

    disk_data = json.loads(written_path.read_text(encoding="utf-8"))
    assert disk_data["session_id"] == "pilot-write-test"
    assert disk_data["events"][0]["response_value"] == "YES"
    _cleanup()


def test_session_writer_creates_parent_directories():
    nested = _TMP / "deep" / "nested"
    _cleanup()
    raw = [{"artifact_id": "a", "question_id": "KP-01", "response_value": "NO", "response_time_ms": 100}]
    session = create_session("s", "p", ["a"], raw)
    path = write_session(session, custom_root=nested)
    assert path.exists()
    _cleanup()


def test_session_writer_filename_includes_session_id():
    _cleanup()
    raw = [{"artifact_id": "a", "question_id": "KP-01", "response_value": "YES", "response_time_ms": 100}]
    session = create_session("my-session-id", "p", ["a"], raw)
    path = write_session(session, custom_root=_TMP)
    assert "my-session-id" in path.name
    _cleanup()


def test_serialized_session_has_correct_participant_id():
    _cleanup()
    raw = [{"artifact_id": "a", "question_id": "KP-01", "response_value": "NO", "response_time_ms": 200}]
    session = create_session("s", "participant-xyz", ["a"], raw)
    path = write_session(session, custom_root=_TMP)
    disk = json.loads(path.read_text(encoding="utf-8"))
    assert disk["participant_id"] == "participant-xyz"
    _cleanup()


def test_serialized_session_protocol_version():
    _cleanup()
    raw = [{"artifact_id": "a", "question_id": "AP-01", "response_value": "DELIBERATE", "response_time_ms": 300}]
    session = create_session("s", "p", ["a"], raw)
    path = write_session(session, custom_root=_TMP)
    disk = json.loads(path.read_text(encoding="utf-8"))
    assert disk["protocol_version"] == "1.0.0"
    _cleanup()

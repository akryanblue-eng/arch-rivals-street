"""Unprivileged disk sink for validated StudySession objects."""

from __future__ import annotations

from pathlib import Path

from human_study.schemas.study_session import StudySession

HUMAN_DATA_ROOT = Path("artifacts/human_study")


def write_session(session: StudySession, custom_root: Path | None = None) -> Path:
    target_root = custom_root if custom_root is not None else HUMAN_DATA_ROOT
    target_root.mkdir(parents=True, exist_ok=True)

    file_path = target_root / f"session_{session.session_id}.json"
    file_path.write_text(session.serialize_session(), encoding="utf-8")
    return file_path

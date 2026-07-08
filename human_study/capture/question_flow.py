"""Versioned question sequence — protocol-defined, state-free, no metadata."""

from __future__ import annotations

import hashlib
import json

QUESTION_SEQUENCE: list[str] = [
    "KP-01",
    "KP-02",
    "KP-03",
    "AP-01",
    "AP-02",
    "AP-03",
]


def get_protocol_questions() -> list[str]:
    return list(QUESTION_SEQUENCE)


def calculate_question_set_hash() -> str:
    canonical_bytes = json.dumps(QUESTION_SEQUENCE, sort_keys=True).encode("utf-8")
    return hashlib.sha256(canonical_bytes).hexdigest()

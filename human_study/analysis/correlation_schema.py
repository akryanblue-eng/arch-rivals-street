"""Immutable relational projection: one machine classification × one question's distribution."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CorrelationRecord:
    study_run_id: str
    artifact_id: str
    machine_classification: str
    question_id: str
    response_distribution: dict
    sample_count: int

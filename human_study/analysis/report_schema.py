"""Canonical, immutable report envelope."""

from __future__ import annotations

import json
from dataclasses import dataclass


@dataclass(frozen=True)
class DivergenceReport:
    report_version: str
    study_run_id: str
    generated_timestamp: str
    matrix_summary: dict
    correlations: list

    def to_dict(self) -> dict:
        return {
            "report_version": self.report_version,
            "study_run_id": self.study_run_id,
            "generated_timestamp": self.generated_timestamp,
            "matrix_summary": self.matrix_summary,
            "correlations": self.correlations,
        }

    def serialize_report(self) -> str:
        return json.dumps(self.to_dict(), sort_keys=True, indent=2)

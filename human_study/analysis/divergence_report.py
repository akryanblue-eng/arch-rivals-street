"""Aggregates CorrelationRecords into a single uninterpreted DivergenceReport.

Strictly forbids subjective terminology, causal speculation, or optimization
directives. The output is a structured observation record, not a verdict.
"""

from __future__ import annotations

from datetime import datetime, timezone

from human_study.analysis.report_schema import DivergenceReport


def generate_divergence_report(
    study_run_id: str,
    correlation_records: list,
) -> DivergenceReport:
    correlations = []
    artifacts: set[str] = set()
    total_samples = 0

    for record in sorted(correlation_records, key=lambda r: (r.artifact_id, r.question_id)):
        artifacts.add(record.artifact_id)
        total_samples += record.sample_count
        correlations.append(
            {
                "artifact_id": record.artifact_id,
                "machine_classification": record.machine_classification,
                "question_id": record.question_id,
                "response_distribution": record.response_distribution,
                "sample_count": record.sample_count,
            }
        )

    return DivergenceReport(
        report_version="1.0.0",
        study_run_id=str(study_run_id),
        generated_timestamp=datetime.now(timezone.utc).isoformat(),
        matrix_summary={
            "artifacts_processed": len(artifacts),
            "total_human_samples": total_samples,
        },
        correlations=correlations,
    )

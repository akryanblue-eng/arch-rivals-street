"""Pure observational join: machine telemetry × human response distributions.

No causal interpretation, no weighting, no cross-artifact contamination.
Artifacts absent from machine_records are silently skipped (structural gap
protection — don't invent machine data).
"""

from __future__ import annotations

from collections import defaultdict

from human_study.analysis.correlation_schema import CorrelationRecord
from human_study.schemas.perception_event import PerceptionEvent


def build_correlation_matrix(
    study_run_id: str,
    machine_records: dict[str, dict],
    perception_events: list[PerceptionEvent],
) -> list[CorrelationRecord]:
    grouped: dict[tuple[str, str], list[str]] = defaultdict(list)
    for event in perception_events:
        grouped[(event.artifact_id, event.question_id)].append(event.response_value)

    results = []
    for (artifact_id, question_id), responses in sorted(grouped.items()):
        machine = machine_records.get(artifact_id)
        if machine is None:
            continue

        counts: dict[str, int] = defaultdict(int)
        for response in responses:
            counts[response] += 1

        total = len(responses)
        distribution = {
            key: float(counts[key]) / total
            for key in sorted(counts.keys())
        }

        results.append(
            CorrelationRecord(
                study_run_id=str(study_run_id),
                artifact_id=artifact_id,
                machine_classification=machine["classification"],
                question_id=question_id,
                response_distribution=distribution,
                sample_count=total,
            )
        )

    return results

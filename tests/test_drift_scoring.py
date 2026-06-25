from engine.drift_scoring import DriftMetrics, classify, compute_drift_score


def test_zero_metrics_are_stable():
    result = compute_drift_score(DriftMetrics())
    assert result["total"] == 0.0
    assert result["classification"] == "STABLE"


def test_classification_bands():
    assert classify(0.0) == "STABLE"
    assert classify(0.15) == "MINOR"
    assert classify(0.40) == "MAJOR"
    assert classify(0.70) == "CRITICAL"
    assert classify(1.0) == "CRITICAL"


def test_breakdown_and_raw_vector_order_match_weights():
    metrics = DriftMetrics(
        asset_entropy=0.2,
        reference_integrity_loss=0.4,
        scene_instability=0.1,
        dependency_graph_fragmentation=0.3,
    )
    result = compute_drift_score(metrics)
    assert result["breakdown"]["reference_integrity_loss"] == 0.4
    assert result["raw_vector"] == [0.2, 0.4, 0.1, 0.3]
    assert 0.0 <= result["total"] <= 1.0


def test_total_is_clamped_to_unit_interval():
    metrics = DriftMetrics(
        asset_entropy=10.0,
        reference_integrity_loss=10.0,
        scene_instability=10.0,
        dependency_graph_fragmentation=10.0,
    )
    result = compute_drift_score(metrics)
    assert result["total"] == 1.0
    assert result["classification"] == "CRITICAL"

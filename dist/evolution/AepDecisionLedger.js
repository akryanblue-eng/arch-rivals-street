"use strict";
// AEP Decision Ledger — evolutionary memory layer for AEP v0.1
//
// Stores a normalized governance record for every evolution attempt.
// Prevents cyclic optimization by enabling deterministic ledger lookup
// before re-attempting a previously evaluated intervention.
//
// Entry IDs are content-addressed (sha256) so duplicate proposals produce
// the same ID regardless of when or where they are evaluated.
Object.defineProperty(exports, "__esModule", { value: true });
exports.appendEntry = appendEntry;
exports.queryPriorIntervention = queryPriorIntervention;
exports.dumpDecisionLedger = dumpDecisionLedger;
exports.resetDecisionLedger = resetDecisionLedger;
const crypto_1 = require("crypto");
// Maps each EvolvableComponent to its intervention ladder classification.
const JUSTIFICATION_LEVEL_MAP = {
    RETRIEVAL: "L1_CONFIG",
    MEMORY_POLICY: "L1_CONFIG",
    TOOL_POLICY: "L2_POLICY",
    PLANNER: "L3_ARCHITECTURE",
    PROMPT: "L3_ARCHITECTURE",
    BASE_MODEL: "L4_CORE_MODEL",
};
// In-process decision ledger. A production implementation writes to a durable
// store (e.g. append-only log, versioned object store).
const decisionLedger = [];
// Compute a content-addressed SHA-256 entry ID.
// Two proposals with identical inputs produce the same ID, making duplicate
// proposals detectable and historical lookup deterministic.
function computeEntryId(targetSubsystem, observedFailure, proposedIntervention, verdict, simulationMetrics) {
    const content = [
        targetSubsystem,
        observedFailure,
        proposedIntervention,
        verdict,
        simulationMetrics
            ? `${simulationMetrics.baseline_error_rate}:${simulationMetrics.simulated_error_rate}`
            : "no-simulation",
    ].join("|");
    return "sha256:" + (0, crypto_1.createHash)("sha256").update(content).digest("hex");
}
function formatRate(rate) {
    return rate.toFixed(6);
}
function deriveReasonCode(decision) {
    switch (decision.outcome) {
        case "PROMOTED":
            return "CONTROLLED_BEHAVIOR_IMPROVEMENT";
        case "REJECTED":
            if (decision.rejectionReason === "MODEL_CHANGE_NOT_JUSTIFIED") {
                return "MODEL_CHANGE_NOT_JUSTIFIED";
            }
            if (decision.rejectionReason === "LADDER_NOT_SATISFIED") {
                return "LADDER_NOT_SATISFIED";
            }
            return "NO_IMPROVEMENT_OBSERVED";
        case "BLOCKED":
            return decision.simulationResult?.harmful
                ? "SIMULATION_SAFETY_VIOLATION"
                : "SIMULATION_PERFORMANCE_REGRESSION";
    }
}
function buildSimulationMetrics(decision) {
    if (!decision.simulationResult)
        return undefined;
    return {
        baseline_error_rate: formatRate(decision.simulationResult.baselineErrorRate),
        simulated_error_rate: formatRate(decision.simulationResult.candidateErrorRate),
    };
}
// Compute an execution hash for decisions where simulation ran.
// Derived from simulation inputs and outcome to support replay verification.
function computeExecutionHash(decision) {
    if (!decision.simulationResult)
        return undefined;
    const { baselineErrorRate, candidateErrorRate, label, harmful } = decision.simulationResult;
    const content = [
        decision.proposal.component,
        decision.proposal.change,
        decision.proposal.ledgerRef,
        String(baselineErrorRate),
        String(candidateErrorRate),
        label,
        String(harmful),
        decision.outcome,
    ].join("|");
    return (0, crypto_1.createHash)("sha256").update(content).digest("hex");
}
// Append a governance decision to the decision ledger.
// Returns the written entry.
function appendEntry(decision, observedFailure, causalSignature) {
    const targetSubsystem = decision.proposal.component;
    const proposedIntervention = decision.proposal.change;
    const justificationLevel = JUSTIFICATION_LEVEL_MAP[targetSubsystem];
    const simulationMetrics = buildSimulationMetrics(decision);
    const verdict = decision.outcome;
    const reasonCode = deriveReasonCode(decision);
    const executionHash = computeExecutionHash(decision);
    const entryId = computeEntryId(targetSubsystem, observedFailure, proposedIntervention, verdict, simulationMetrics);
    const entry = {
        entry_id: entryId,
        timestamp_utc: new Date().toISOString(),
        target_subsystem: targetSubsystem,
        proposal: {
            observed_failure: observedFailure,
            proposed_intervention: proposedIntervention,
            justification_level: justificationLevel,
        },
        governance_evaluation: {
            verdict,
            reason_code: reasonCode,
            ...(simulationMetrics !== undefined && {
                simulation_metrics: simulationMetrics,
            }),
        },
        audit_trail: {
            simulation_verified: decision.simulationResult !== undefined,
            tampered_deploy_attempt_detected: false,
            ...(executionHash !== undefined && { execution_hash: executionHash }),
        },
        ...(causalSignature !== undefined && { causal_signature: causalSignature }),
    };
    decisionLedger.push(entry);
    return entry;
}
// AEP-MEM-001: Query the decision ledger before attempting an intervention.
//
// Searches by target_subsystem (exact) and proposal_class (substring match on
// proposed_intervention). Returns a memory query response indicating whether
// the intervention has been attempted before and what the outcome was.
//
// Optimization constraint: If the previous verdict was BLOCKED or REJECTED,
// recommends DO_NOT_RETRY_WITHOUT_NEW_EVIDENCE to prevent the evolution loop
// from repeating historical regressions.
function queryPriorIntervention(request) {
    const matches = decisionLedger.filter((e) => e.target_subsystem === request.target_subsystem &&
        e.proposal.proposed_intervention
            .toLowerCase()
            .includes(request.proposal_class.toLowerCase()));
    if (matches.length === 0) {
        return {
            query: request,
            historical_match: false,
            recommended_action: "PROCEED_TO_SIMULATION",
            result: "NOVEL_INTERVENTION",
        };
    }
    // Use the most recent matching entry.
    const latest = matches[matches.length - 1];
    const verdict = latest.governance_evaluation.verdict;
    const metrics = latest.governance_evaluation.simulation_metrics;
    let result;
    switch (verdict) {
        case "PROMOTED":
            result = "PRIOR_SUCCESS";
            break;
        case "BLOCKED":
            result = "PRIOR_FAILURE";
            break;
        case "REJECTED":
            result = "PRIOR_REJECTION";
            break;
    }
    const recommended_action = verdict === "BLOCKED" || verdict === "REJECTED"
        ? "DO_NOT_RETRY_WITHOUT_NEW_EVIDENCE"
        : "PROCEED_TO_SIMULATION";
    return {
        query: request,
        historical_match: true,
        previous_verdict: verdict,
        ...(metrics !== undefined && {
            previous_metrics: {
                baseline: metrics.baseline_error_rate,
                result: metrics.simulated_error_rate,
            },
        }),
        recommended_action,
        result,
    };
}
// Return a frozen copy of the full decision ledger.
function dumpDecisionLedger() {
    return Object.freeze([...decisionLedger]);
}
// Reset the in-process ledger for isolated test runs.
function resetDecisionLedger() {
    decisionLedger.length = 0;
}

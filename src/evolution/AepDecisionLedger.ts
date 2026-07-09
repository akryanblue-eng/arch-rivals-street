// AEP Decision Ledger — evolutionary memory layer for AEP v0.1
//
// Stores a normalized governance record for every evolution attempt.
// Prevents cyclic optimization by enabling deterministic ledger lookup
// before re-attempting a previously evaluated intervention.
//
// Entry IDs are content-addressed (sha256) so duplicate proposals produce
// the same ID regardless of when or where they are evaluated.
//
// AEP-MEM-001: queryPriorIntervention() — lookup before re-attempting.
// AEP-MEM-002: evaluateContextDelta()   — contradiction resolution.
//   When a historical veto exists, AEP-MEM-002 compares the current
//   evaluation context against the context stored in the historical entry.
//   If context has changed (Delta != Null), the veto is evaporated and
//   the system proceeds to simulation. If context is identical (Delta == Null),
//   HALTED_BY_MEMORY is returned without wasting simulation resources.

import { createHash } from "crypto";
import { AepDecision, EvolvableComponent } from "./AgentEvolutionProtocol";

// Justification levels map the EvolvableComponent ladder to intervention classes.
// Lower levels represent smaller, less invasive changes.
export type JustificationLevel =
  | "L1_CONFIG"
  | "L2_POLICY"
  | "L3_ARCHITECTURE"
  | "L4_CORE_MODEL";

export type LedgerVerdict = "PROMOTED" | "REJECTED" | "BLOCKED";

// AEP-MEM-002: Resolution strategies for contradiction resolution.
// When a historical veto is challenged by changed context, the system
// classifies the change before evaporating the veto.
//
// SIMULATOR_INVALIDATION  — the old verdict was an artifact of a flawed or
//                           outdated simulator; a more accurate simulator now
//                           exists.
// CONTEXTUAL_BIFURCATION  — the intervention targets a different domain or
//                           sub-system than the historical failure context;
//                           the old veto should not transfer.
// BOUNDARY_SHIFT          — an environmental dependency or acceptance
//                           threshold has moved, making a previously blocked
//                           intervention viable.
export type ResolutionType =
  | "SIMULATOR_INVALIDATION"
  | "CONTEXTUAL_BIFURCATION"
  | "BOUNDARY_SHIFT";

export type LedgerReasonCode =
  | "CONTROLLED_BEHAVIOR_IMPROVEMENT"
  | "MODEL_CHANGE_NOT_JUSTIFIED"
  | "LADDER_NOT_SATISFIED"
  | "NO_IMPROVEMENT_OBSERVED"
  | "SIMULATION_PERFORMANCE_REGRESSION"
  | "SIMULATION_SAFETY_VIOLATION";

// AEP-MEM-001: result codes returned by ledger memory queries.
export type MemoryQueryResult =
  | "PRIOR_SUCCESS"
  | "PRIOR_FAILURE"
  | "PRIOR_REJECTION"
  | "NOVEL_INTERVENTION";

// Free-form key-value pairs describing the evaluation context at the time
// a ledger entry was recorded. Enables AEP-MEM-002 to compute a context
// delta when re-evaluating a previously vetoed intervention.
export type ContextMetadata = Record<string, string>;

// A single changed field captured in a context delta.
export interface ContextDeltaField {
  old: string;
  new: string;
}

// AEP-MEM-002: resolution context written into a ledger entry that
// overrules a prior veto. Creates a first-class relationship between
// the new decision and the historical entry it supersedes.
export interface ResolutionContext {
  resolution_type: ResolutionType;
  overruled_entry_id: string;
  context_delta: Record<string, ContextDeltaField>;
  evidence_required: boolean;
}

export interface LedgerProposal {
  observed_failure: string;
  proposed_intervention: string;
  justification_level: JustificationLevel;
}

export interface SimulationMetrics {
  baseline_error_rate: string;
  simulated_error_rate: string;
}

export interface GovernanceEvaluation {
  verdict: LedgerVerdict;
  reason_code: LedgerReasonCode;
  simulation_metrics?: SimulationMetrics;
}

export interface AuditTrail {
  simulation_verified: boolean;
  tampered_deploy_attempt_detected: boolean;
  execution_hash?: string;
}

// Optional causal context enabling clustering of related failures.
// The same intervention may appear under different surface symptoms
// (e.g. slow retrieval vs tool timeout both caused by index degradation).
// A causal signature allows deduplication and cross-failure analysis.
export interface CausalSignature {
  failure_class: string;
  affected_metric: string;
  origin_event_hash?: string;
}

export interface AepDecisionLedgerEntry {
  entry_id: string;
  timestamp_utc: string;
  target_subsystem: EvolvableComponent;
  proposal: LedgerProposal;
  governance_evaluation: GovernanceEvaluation;
  audit_trail: AuditTrail;
  causal_signature?: CausalSignature;
  context_metadata?: ContextMetadata;
  resolution_context?: ResolutionContext;
}

export interface MemoryQueryRequest {
  target_subsystem: EvolvableComponent;
  proposal_class: string;
}

export interface MemoryQueryResponse {
  query: MemoryQueryRequest;
  historical_match: boolean;
  previous_verdict?: LedgerVerdict;
  previous_metrics?: {
    baseline: string;
    result: string;
  };
  recommended_action:
    | "PROCEED_TO_SIMULATION"
    | "DO_NOT_RETRY_WITHOUT_NEW_EVIDENCE";
  result: MemoryQueryResult;
}

// AEP-MEM-002: input for the context delta check.
export interface ContextCheckRequest {
  target_subsystem: EvolvableComponent;
  proposal_class: string;
  current_context: ContextMetadata;
}

// Outcome of an AEP-MEM-002 context delta evaluation.
//
// HALTED_BY_MEMORY  — context is identical to the historical veto; the system
//                     should not retry without additional evidence.
// VETO_EVAPORATED   — context has changed sufficiently; the historical veto
//                     no longer applies; proceed to ladder check and simulation.
export type ContextCheckOutcome = "HALTED_BY_MEMORY" | "VETO_EVAPORATED";

export interface ContextCheckResponse {
  outcome: ContextCheckOutcome;
  overruled_entry_id?: string;
  resolution_type?: ResolutionType;
  context_delta?: Record<string, ContextDeltaField>;
}

// Maps each EvolvableComponent to its intervention ladder classification.
const JUSTIFICATION_LEVEL_MAP: Record<EvolvableComponent, JustificationLevel> =
  {
    RETRIEVAL: "L1_CONFIG",
    MEMORY_POLICY: "L1_CONFIG",
    TOOL_POLICY: "L2_POLICY",
    PLANNER: "L3_ARCHITECTURE",
    PROMPT: "L3_ARCHITECTURE",
    BASE_MODEL: "L4_CORE_MODEL",
  };

// In-process decision ledger. A production implementation writes to a durable
// store (e.g. append-only log, versioned object store).
const decisionLedger: AepDecisionLedgerEntry[] = [];

// Compute a content-addressed SHA-256 entry ID.
// Two proposals with identical inputs produce the same ID, making duplicate
// proposals detectable and historical lookup deterministic.
function computeEntryId(
  targetSubsystem: EvolvableComponent,
  observedFailure: string,
  proposedIntervention: string,
  verdict: LedgerVerdict,
  simulationMetrics: SimulationMetrics | undefined
): string {
  const content = [
    targetSubsystem,
    observedFailure,
    proposedIntervention,
    verdict,
    simulationMetrics
      ? `${simulationMetrics.baseline_error_rate}:${simulationMetrics.simulated_error_rate}`
      : "no-simulation",
  ].join("|");
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

function formatRate(rate: number): string {
  return rate.toFixed(6);
}

function deriveReasonCode(decision: AepDecision): LedgerReasonCode {
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

function buildSimulationMetrics(
  decision: AepDecision
): SimulationMetrics | undefined {
  if (!decision.simulationResult) return undefined;
  return {
    baseline_error_rate: formatRate(decision.simulationResult.baselineErrorRate),
    simulated_error_rate: formatRate(
      decision.simulationResult.candidateErrorRate
    ),
  };
}

// Compute an execution hash for decisions where simulation ran.
// Derived from simulation inputs and outcome to support replay verification.
function computeExecutionHash(decision: AepDecision): string | undefined {
  if (!decision.simulationResult) return undefined;
  const { baselineErrorRate, candidateErrorRate, label, harmful } =
    decision.simulationResult;
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
  return createHash("sha256").update(content).digest("hex");
}

// Append a governance decision to the decision ledger.
// Returns the written entry.
export function appendEntry(
  decision: AepDecision,
  observedFailure: string,
  causalSignature?: CausalSignature,
  contextMetadata?: ContextMetadata,
  resolutionContext?: ResolutionContext
): AepDecisionLedgerEntry {
  const targetSubsystem = decision.proposal.component;
  const proposedIntervention = decision.proposal.change;
  const justificationLevel = JUSTIFICATION_LEVEL_MAP[targetSubsystem];
  const simulationMetrics = buildSimulationMetrics(decision);
  const verdict: LedgerVerdict = decision.outcome;
  const reasonCode = deriveReasonCode(decision);
  const executionHash = computeExecutionHash(decision);

  const entryId = computeEntryId(
    targetSubsystem,
    observedFailure,
    proposedIntervention,
    verdict,
    simulationMetrics
  );

  const entry: AepDecisionLedgerEntry = {
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
    ...(contextMetadata !== undefined && { context_metadata: contextMetadata }),
    ...(resolutionContext !== undefined && { resolution_context: resolutionContext }),
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
export function queryPriorIntervention(
  request: MemoryQueryRequest
): MemoryQueryResponse {
  const matches = decisionLedger.filter(
    (e) =>
      e.target_subsystem === request.target_subsystem &&
      e.proposal.proposed_intervention
        .toLowerCase()
        .includes(request.proposal_class.toLowerCase())
  );

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

  let result: MemoryQueryResult;
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

  const recommended_action =
    verdict === "BLOCKED" || verdict === "REJECTED"
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
export function dumpDecisionLedger(): readonly AepDecisionLedgerEntry[] {
  return Object.freeze([...decisionLedger]);
}

// AEP-MEM-002: Evaluate whether the current evaluation context differs from
// the context stored in the most recent BLOCKED or REJECTED ledger entry for
// the same intervention class.
//
// Control flow:
//
//   Prior decision found
//        │
//        ▼
//   Compare current_context vs entry.context_metadata
//        │
//   ┌────┴────────────────────────────┐
//   │                                 │
//   ▼                                 ▼
// Delta == Null               Delta != Null
// (identical context)         (environmental drift)
//        │                            │
//        ▼                            ▼
// HALTED_BY_MEMORY            VETO_EVAPORATED
//                             (proceed to simulation)
//
// If no prior failure is found, returns VETO_EVAPORATED (no veto to evaluate).
// If a prior failure exists but carries no context_metadata, returns
// HALTED_BY_MEMORY — absent metadata is treated as identical context to
// prevent an evidence-free override.
export function evaluateContextDelta(
  request: ContextCheckRequest
): ContextCheckResponse {
  const failureMatches = decisionLedger.filter(
    (e) =>
      e.target_subsystem === request.target_subsystem &&
      e.proposal.proposed_intervention
        .toLowerCase()
        .includes(request.proposal_class.toLowerCase()) &&
      (e.governance_evaluation.verdict === "BLOCKED" ||
        e.governance_evaluation.verdict === "REJECTED")
  );

  if (failureMatches.length === 0) {
    return { outcome: "VETO_EVAPORATED" };
  }

  const latest = failureMatches[failureMatches.length - 1];
  const historicalContext = latest.context_metadata;

  // No stored context metadata means the original entry predates context
  // tracking. Treat as identical context — require explicit new evidence.
  if (historicalContext === undefined) {
    return {
      outcome: "HALTED_BY_MEMORY",
      overruled_entry_id: latest.entry_id,
    };
  }

  // Compute the context delta: fields that exist in both contexts but differ,
  // or fields present in one context but absent from the other.
  const delta: Record<string, ContextDeltaField> = {};
  const allKeys = new Set([
    ...Object.keys(historicalContext),
    ...Object.keys(request.current_context),
  ]);

  for (const key of allKeys) {
    const oldVal = historicalContext[key];
    const newVal = request.current_context[key];
    if (oldVal !== newVal) {
      delta[key] = {
        old: oldVal ?? "(absent)",
        new: newVal ?? "(absent)",
      };
    }
  }

  if (Object.keys(delta).length === 0) {
    // Delta == Null: context is identical — veto stands.
    return {
      outcome: "HALTED_BY_MEMORY",
      overruled_entry_id: latest.entry_id,
    };
  }

  // Delta != Null: context has changed — classify the resolution type and
  // evaporate the veto.
  const resolution_type = inferResolutionType(delta);

  return {
    outcome: "VETO_EVAPORATED",
    overruled_entry_id: latest.entry_id,
    resolution_type,
    context_delta: delta,
  };
}

// Infer the resolution type from the changed context fields.
// Checks for well-known simulator-related keys first; falls back to
// BOUNDARY_SHIFT for other environmental changes.
function inferResolutionType(
  delta: Record<string, ContextDeltaField>
): ResolutionType {
  const keys = Object.keys(delta);
  if (
    keys.some(
      (k) =>
        k.toLowerCase().includes("simulator") ||
        k.toLowerCase().includes("interpolation")
    )
  ) {
    return "SIMULATOR_INVALIDATION";
  }
  if (keys.some((k) => k.toLowerCase().includes("domain"))) {
    return "CONTEXTUAL_BIFURCATION";
  }
  return "BOUNDARY_SHIFT";
}

// Reset the in-process ledger for isolated test runs.
export function resetDecisionLedger(): void {
  decisionLedger.length = 0;
}

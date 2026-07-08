// Proof slice E — AEP v0.1
// Evidence artifact for URS-BETA-005 (Agent Evolution Governance).
//
// Decision trace for each outcome:
//   Input Experience → RIG Ledger Evidence → Diagnosis →
//   Evolution Proposal → Simulation Result → Governance Decision → Audit Record
//
// Three canonical cases:
//   Case 1: Retrieval fix        → IMPROVED  (0.60→0.00) → PROMOTED
//   Case 2: Base-model retrain   → Not justified          → REJECTED (MODEL_CHANGE_NOT_JUSTIFIED)
//   Case 3: Tool-policy change   → REGRESSED (0.60→0.80) → BLOCKED
//
// Adversarial audit:
//   Direct-deploy attempt without AEP simulation            → DETECTED
//   Simulation gate enforcement (BLOCKED stops deployment)  → ENFORCED
//
// Run with: node -r ts-node/register src/runSliceE.ts

import {
  propose,
  resetSession,
  AepProposal,
} from "./evolution/AgentEvolutionProtocol";

import {
  record,
  recordProposalCreated,
  recordSimulationEnforced,
  attemptDirectDeploy,
  buildEvidenceRecord,
  dumpLedger,
  resetLedger,
  SliceEvidenceRecord,
} from "./evolution/evolutionReplayAudit";

import {
  appendEntry,
  queryPriorIntervention,
  dumpDecisionLedger,
  resetDecisionLedger,
} from "./evolution/AepDecisionLedger";

function run(): void {
  resetSession();
  resetLedger();
  resetDecisionLedger();

  const sliceOutcomes: SliceEvidenceRecord["outcomes"] = [];

  // ── Case 1: Retrieval fix ────────────────────────────────────────────────
  //
  // Input Experience:  Agent fails to retrieve relevant context for a query.
  // RIG Ledger:        Failure event rig-failure-2026-07-08-001 logged with
  //                    error rate 0.60 on the replay window.
  // Diagnosis:         Retrieval component returning truncated context (512 tok).
  // Proposal:          Increase retrieval context window to 1024 tokens.
  // Simulation:        Replay against failure window → error rate 0.00.
  // Governance:        IMPROVED → PROMOTED. Smallest justified change.
  // Audit:             aep.proposal.promoted written to RIG ledger.

  const retrievalProposal: AepProposal = {
    proposalId: "prop-001",
    component: "RETRIEVAL",
    change: "Increase context window from 512 to 1024 tokens.",
    ledgerRef: "rig-failure-2026-07-08-001",
  };

  recordProposalCreated(retrievalProposal);

  const retrievalDecision = propose(retrievalProposal, () => ({
    baselineErrorRate: 0.60,
    candidateErrorRate: 0.00,
    harmful: false,
  }));

  const retrievalEvent = record(retrievalDecision);

  console.log(
    `Case 1 — RETRIEVAL: ${retrievalDecision.outcome}` +
      ` [${retrievalDecision.simulationResult?.label}` +
      ` ${retrievalDecision.simulationResult?.baselineErrorRate}→` +
      `${retrievalDecision.simulationResult?.candidateErrorRate}]`
  );

  assert(retrievalDecision.outcome === "PROMOTED", "Case 1 must be PROMOTED");
  assert(retrievalDecision.simulationResult?.label === "IMPROVED", "Case 1 simulation must be IMPROVED");
  assert(retrievalEvent.eventType === "aep.proposal.promoted", "Case 1 event type");

  sliceOutcomes.push({
    case: "retrieval_fix",
    decision: "PROMOTED",
    simulation: "IMPROVED",
    before: retrievalDecision.simulationResult!.baselineErrorRate,
    after: retrievalDecision.simulationResult!.candidateErrorRate,
  });

  appendEntry(
    retrievalDecision,
    "Retrieval precision drop causing downstream execution latency friction.",
    {
      failure_class: "RETRIEVAL_PRECISION_DEGRADATION",
      affected_metric: "execution_latency",
      origin_event_hash: retrievalProposal.ledgerRef,
    }
  );

  // ── Case 2: Base-model retrain ───────────────────────────────────────────
  //
  // Input Experience:  Same failure class as Case 1.
  // RIG Ledger:        Same replay window (rig-failure-2026-07-08-001).
  // Diagnosis:         Someone proposes a full BASE_MODEL retrain as the fix.
  // Proposal:          Fine-tune on extended gameplay corpus.
  // Governance:        RETRIEVAL has not been rejected — ladder constraint not
  //                    satisfied. BASE_MODEL change is not justified. Proposal
  //                    declined before simulation runs.
  //                    Reason: MODEL_CHANGE_NOT_JUSTIFIED.
  // Audit:             aep.proposal.rejected written to RIG ledger.
  //
  // Note: REJECTED ≠ FAILED. The governance layer made an intentional decision.
  // No simulation was needed — the evidence of ladder exhaustion was absent.

  const baseModelProposal: AepProposal = {
    proposalId: "prop-020",
    component: "BASE_MODEL",
    change: "Fine-tune on extended gameplay corpus.",
    ledgerRef: "rig-failure-2026-07-08-001",
  };

  recordProposalCreated(baseModelProposal);

  const baseModelDecision = propose(baseModelProposal, () => ({
    // This runner is never called: ladder check fires first.
    baselineErrorRate: 0.60,
    candidateErrorRate: 0.60,
    harmful: false,
  }));

  const baseModelEvent = record(baseModelDecision);

  console.log(
    `Case 2 — BASE_MODEL: ${baseModelDecision.outcome}` +
      ` [reason=${baseModelDecision.rejectionReason}]`
  );

  assert(baseModelDecision.outcome === "REJECTED", "Case 2 must be REJECTED");
  assert(baseModelDecision.rejectionReason === "MODEL_CHANGE_NOT_JUSTIFIED", "Case 2 rejection reason");
  assert(baseModelDecision.simulationResult === undefined, "Case 2 must not have run simulation");
  assert(baseModelEvent.eventType === "aep.proposal.rejected", "Case 2 event type");

  sliceOutcomes.push({
    case: "base_model_retrain",
    decision: "REJECTED",
    reason: "MODEL_CHANGE_NOT_JUSTIFIED",
  });

  appendEntry(
    baseModelDecision,
    "Retrieval precision drop causing downstream execution latency friction.",
    {
      failure_class: "RETRIEVAL_PRECISION_DEGRADATION",
      affected_metric: "execution_latency",
      origin_event_hash: baseModelProposal.ledgerRef,
    }
  );

  // ── Case 3: Tool-policy change ───────────────────────────────────────────
  //
  // Input Experience:  Separate failure — agent unable to complete write task.
  // RIG Ledger:        Failure event rig-failure-2026-07-08-002 logged with
  //                    error rate 0.60.
  // Diagnosis:         (Adversarial) proposal to remove write-API confirmation.
  // Proposal:          Allow agent to invoke external write APIs without guard.
  // Simulation:        Replay → error rate increases to 0.80. Harmful detected.
  // Governance:        REGRESSED → BLOCKED. Simulation prevented deployment.
  // Audit:             aep.simulation.blocked + aep.audit.simulation_enforced
  //                    written to RIG ledger.
  //
  // Note: BLOCKED ≠ REJECTED. The simulation gate fired. The proposal never
  // reached the improvement evaluation. No deployment occurred.

  const toolPolicyProposal: AepProposal = {
    proposalId: "prop-030",
    component: "TOOL_POLICY",
    change: "Allow agent to invoke external write APIs without confirmation.",
    ledgerRef: "rig-failure-2026-07-08-002",
  };

  recordProposalCreated(toolPolicyProposal);

  const toolPolicyDecision = propose(toolPolicyProposal, () => ({
    baselineErrorRate: 0.60,
    candidateErrorRate: 0.80,
    harmful: true,
  }));

  const toolPolicyEvent = record(toolPolicyDecision);

  // Explicit audit checkpoint: simulation gate blocked this deployment.
  recordSimulationEnforced(toolPolicyProposal.proposalId, toolPolicyProposal.ledgerRef);

  console.log(
    `Case 3 — TOOL_POLICY: ${toolPolicyDecision.outcome}` +
      ` [${toolPolicyDecision.simulationResult?.label}` +
      ` ${toolPolicyDecision.simulationResult?.baselineErrorRate}→` +
      `${toolPolicyDecision.simulationResult?.candidateErrorRate}]`
  );

  assert(toolPolicyDecision.outcome === "BLOCKED", "Case 3 must be BLOCKED");
  assert(toolPolicyDecision.simulationResult?.label === "REGRESSED", "Case 3 simulation must be REGRESSED");
  assert(toolPolicyEvent.eventType === "aep.simulation.blocked", "Case 3 event type");

  sliceOutcomes.push({
    case: "tool_policy_change",
    decision: "BLOCKED",
    simulation: "REGRESSED",
    before: toolPolicyDecision.simulationResult!.baselineErrorRate,
    after: toolPolicyDecision.simulationResult!.candidateErrorRate,
  });

  appendEntry(
    toolPolicyDecision,
    "Edge-case physics exceptions tracking drift during rapid movement updates.",
    {
      failure_class: "TOOL_POLICY_SAFETY_REGRESSION",
      affected_metric: "error_rate",
      origin_event_hash: toolPolicyProposal.ledgerRef,
    }
  );

  // ── Adversarial audit: tampered-ledger direct-deploy attempt ────────────
  //
  // An actor attempts to deploy a change by calling deploy logic directly,
  // bypassing the AEP simulation requirement. The audit layer intercepts this,
  // records a tamper event, and returns DETECTED. No deployment occurs.

  const tamperedResult = attemptDirectDeploy("prop-adversarial-001");
  assert(tamperedResult === "DETECTED", "Tampered deploy attempt must be DETECTED");
  console.log(`Adversarial audit — direct deploy attempt: ${tamperedResult}`);

  // ── Evidence record ───────────────────────────────────────────────────────
  const evidence = buildEvidenceRecord(sliceOutcomes);

  assert(
    evidence.audit.tampered_ledger_deploy_attempt === "DETECTED",
    "Evidence: tampered_ledger_deploy_attempt must be DETECTED"
  );
  assert(
    evidence.audit.simulation_requirement === "ENFORCED",
    "Evidence: simulation_requirement must be ENFORCED"
  );

  const events = dumpLedger();
  console.log(`\nRIG ledger entries recorded: ${events.length}`);
  console.log("\nSlice E evidence record:");
  console.log(JSON.stringify(evidence, null, 2));

  // ── AEP Decision Ledger ───────────────────────────────────────────────────
  //
  // The decision ledger is the evolutionary memory layer. Each entry records
  // the full governance trace: what changed, why it was proposed, whether it
  // was simulated, what was measured, and what the verdict was.
  const decisionLedgerEntries = dumpDecisionLedger();
  console.log(`\nAEP Decision Ledger entries: ${decisionLedgerEntries.length}`);
  console.log(JSON.stringify(decisionLedgerEntries, null, 2));

  // ── AEP-MEM-001: Memory query contract ───────────────────────────────────
  //
  // Before re-attempting an intervention, the evolution loop queries the ledger
  // to avoid repeating known failures. If a prior verdict was BLOCKED or
  // REJECTED the query returns DO_NOT_RETRY_WITHOUT_NEW_EVIDENCE.

  // Query 1: Known blocked intervention — should not be retried.
  const toolPolicyQuery = queryPriorIntervention({
    target_subsystem: "TOOL_POLICY",
    proposal_class: "write APIs",
  });
  console.log("\nAEP-MEM-001 query — tool policy (prior BLOCKED):");
  console.log(JSON.stringify(toolPolicyQuery, null, 2));
  assert(
    toolPolicyQuery.result === "PRIOR_FAILURE",
    "Memory query must return PRIOR_FAILURE for blocked tool policy"
  );
  assert(
    toolPolicyQuery.recommended_action === "DO_NOT_RETRY_WITHOUT_NEW_EVIDENCE",
    "Memory query must recommend DO_NOT_RETRY_WITHOUT_NEW_EVIDENCE for blocked intervention"
  );

  // Query 2: Novel intervention — no prior history, simulation allowed.
  const novelQuery = queryPriorIntervention({
    target_subsystem: "PLANNER",
    proposal_class: "reorder planning steps",
  });
  console.log("\nAEP-MEM-001 query — planner (novel):");
  console.log(JSON.stringify(novelQuery, null, 2));
  assert(
    novelQuery.result === "NOVEL_INTERVENTION",
    "Novel planner query must return NOVEL_INTERVENTION"
  );
  assert(
    novelQuery.recommended_action === "PROCEED_TO_SIMULATION",
    "Novel intervention must recommend PROCEED_TO_SIMULATION"
  );

  console.log("\nAll assertions passed. AEP v0.1 proof slice complete.");
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

run();

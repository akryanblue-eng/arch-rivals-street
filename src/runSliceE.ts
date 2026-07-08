// Proof slice E — AEP v0.1
// Evidence artifact for URS-BETA-005 (Agent Evolution Governance).
//
// Decision trace for each outcome:
//   Input Experience → RIG Ledger Evidence → Diagnosis →
//   AEP-MEM-001 Memory Query → Novel / Known →
//   Evolution Proposal → Simulation Result → Governance Decision →
//   Audit Record → Append causal record to Decision Ledger
//
// Five canonical cases:
//   Case 1: Retrieval fix            → IMPROVED  (0.60→0.00) → PROMOTED
//   Case 2: Base-model retrain       → Not justified          → REJECTED (MODEL_CHANGE_NOT_JUSTIFIED)
//   Case 3: Tool-policy change       → REGRESSED (0.60→0.80) → BLOCKED
//   Case 4: Historical restraint     → AEP-MEM-001 PRIOR_FAILURE → HALTED (no simulation)
//   Case 5: Novel exploration        → AEP-MEM-001 NOVEL_INTERVENTION → IMPROVED (0.45→0.10) → PROMOTED
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

  // ── Case 4: Historical restraint ─────────────────────────────────────────
  //
  // Input Experience:  A second actor attempts to re-propose the same
  //                    TOOL_POLICY change that was BLOCKED in Case 3.
  // AEP-MEM-001:       The evolution loop queries the decision ledger before
  //                    committing to simulation. The ledger returns PRIOR_FAILURE
  //                    (Case 3's BLOCKED outcome) and recommends
  //                    DO_NOT_RETRY_WITHOUT_NEW_EVIDENCE.
  // Governance:        Memory gate halts the proposal. No simulation is run.
  //                    The evolution loop does not proceed.
  // Why this matters:  Prevents an optimizer from slightly renaming a known-
  //                    harmful proposal and re-attempting it indefinitely.

  const historicalRestraintQuery = queryPriorIntervention({
    target_subsystem: "TOOL_POLICY",
    proposal_class: "write APIs",
  });

  console.log("\nCase 4 — TOOL_POLICY re-attempt (historical restraint):");
  console.log(JSON.stringify(historicalRestraintQuery, null, 2));

  assert(
    historicalRestraintQuery.result === "PRIOR_FAILURE",
    "Case 4: memory query must return PRIOR_FAILURE for blocked tool policy"
  );
  assert(
    historicalRestraintQuery.recommended_action === "DO_NOT_RETRY_WITHOUT_NEW_EVIDENCE",
    "Case 4: memory gate must recommend DO_NOT_RETRY_WITHOUT_NEW_EVIDENCE"
  );

  sliceOutcomes.push({
    case: "tool_policy_reattempt_halted",
    decision: "HALTED_BY_MEMORY",
    reason: "DO_NOT_RETRY_WITHOUT_NEW_EVIDENCE",
  });

  // ── Case 5: Novel exploration ─────────────────────────────────────────────
  //
  // Input Experience:  New failure class — agent planner producing suboptimal
  //                    execution plans under resource contention.
  // RIG Ledger:        Failure event rig-failure-2026-07-08-003 logged with
  //                    error rate 0.45 on the replay window.
  // AEP-MEM-001:       The evolution loop queries the decision ledger. No prior
  //                    history exists for this intervention. Returns
  //                    NOVEL_INTERVENTION → PROCEED_TO_SIMULATION.
  // Simulation:        Replay against failure window → error rate 0.10.
  // Governance:        IMPROVED → PROMOTED.
  // Audit:             appendEntry records the verdict; future queries for this
  //                    intervention class will find this result in the ledger.
  // Why this matters:  A memory system that only blocks becomes a prison. Novel
  //                    paths must be allowed through; the ledger learns from them.

  const novelExplorationQuery = queryPriorIntervention({
    target_subsystem: "PLANNER",
    proposal_class: "reorder planning steps",
  });

  console.log("\nCase 5 — PLANNER novel intervention (novel exploration):");
  console.log(JSON.stringify(novelExplorationQuery, null, 2));

  assert(
    novelExplorationQuery.result === "NOVEL_INTERVENTION",
    "Case 5: memory query must return NOVEL_INTERVENTION for novel planner intervention"
  );
  assert(
    novelExplorationQuery.recommended_action === "PROCEED_TO_SIMULATION",
    "Case 5: novel intervention must be cleared for PROCEED_TO_SIMULATION"
  );

  const plannerProposal: AepProposal = {
    proposalId: "prop-050",
    component: "PLANNER",
    change: "Reorder planning steps to check tool availability before resource allocation.",
    ledgerRef: "rig-failure-2026-07-08-003",
  };

  recordProposalCreated(plannerProposal);

  const plannerDecision = propose(plannerProposal, () => ({
    baselineErrorRate: 0.45,
    candidateErrorRate: 0.10,
    harmful: false,
  }));

  const plannerEvent = record(plannerDecision);

  console.log(
    `Case 5 — PLANNER: ${plannerDecision.outcome}` +
      ` [${plannerDecision.simulationResult?.label}` +
      ` ${plannerDecision.simulationResult?.baselineErrorRate}→` +
      `${plannerDecision.simulationResult?.candidateErrorRate}]`
  );

  assert(plannerDecision.outcome === "PROMOTED", "Case 5 must be PROMOTED");
  assert(plannerDecision.simulationResult?.label === "IMPROVED", "Case 5 simulation must be IMPROVED");
  assert(plannerEvent.eventType === "aep.proposal.promoted", "Case 5 event type");

  sliceOutcomes.push({
    case: "planner_novel_exploration",
    decision: "PROMOTED",
    simulation: "IMPROVED",
    before: plannerDecision.simulationResult!.baselineErrorRate,
    after: plannerDecision.simulationResult!.candidateErrorRate,
  });

  appendEntry(
    plannerDecision,
    "Planner producing suboptimal execution order under resource contention.",
    {
      failure_class: "PLANNER_EXECUTION_ORDER_DEGRADATION",
      affected_metric: "execution_error_rate",
      origin_event_hash: plannerProposal.ledgerRef,
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

  console.log("\nAll assertions passed. AEP v0.1 proof slice complete.");
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

run();

// Proof slice E — AEP v0.1
// Evidence artifact for URS-BETA-005 (Agent Evolution Governance).
//
// Decision trace for each outcome:
//   Input Experience → RIG Ledger Evidence → Diagnosis →
//   AEP-MEM-001 Memory Query → Novel / Known →
//   AEP-MEM-002 Context Check (if prior exists) →
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
// Contradiction resolution case:
//   Case 6: AEP-MEM-002 SIMULATOR_INVALIDATION
//           Historical BLOCKED (v1 simulator) + context delta (v2 simulator)
//           → VETO_EVAPORATED → IMPROVED (0.45→0.05) → PROMOTED
//
// Adversarial audit:
//   Direct-deploy attempt without AEP simulation            → DETECTED
//   Simulation gate enforcement (BLOCKED stops deployment)  → ENFORCED
//
// Run with: npx tsc && node dist/runSliceE.js

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
  evaluateContextDelta,
  dumpDecisionLedger,
  resetDecisionLedger,
} from "./evolution/AepDecisionLedger";

import {
  registerPrinciple,
  detectConflict,
  resolveConflict,
  aggregateEnvelopeCheck,
  reactivatePrinciple,
  supersedePrinciple,
  deprecatePrinciple,
  retirePrinciple,
  dumpPrincipleRegistry,
  dumpResolutionLog,
  resetPrincipleRegistry,
  MAX_AGGREGATE_TOLERANCE,
} from "./evolution/AepPrincipleRegistry";

function run(): void {
  resetSession();
  resetLedger();
  resetDecisionLedger();
  resetPrincipleRegistry();

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

  // ── Case 6: AEP-MEM-002 — Contradiction Resolution (Simulator Invalidation) ──
  //
  // Background:   A TOOL_POLICY mutation to bypass high-frequency position
  //               micro-checks was BLOCKED in a prior governance cycle because
  //               simulator v1.0.2-legacy misclassified valid crossover movement
  //               as a position desync regression (false harmful signal).
  //
  // Step 6a:      Seed the historical BLOCKED entry using the legacy simulator
  //               context. This represents the record that would have been written
  //               when the original evaluation ran under v1.0.2-legacy.
  //
  // Step 6b:      AEP-MEM-001 query on a re-proposal confirms PRIOR_FAILURE.
  //               Memory gate recommends DO_NOT_RETRY_WITHOUT_NEW_EVIDENCE.
  //
  // Step 6c:      AEP-MEM-002 context check — same context → HALTED_BY_MEMORY.
  //               Developer upgrades to simulator v2.0.0-high-fidelity.
  //               AEP-MEM-002 context check — changed context → VETO_EVAPORATED.
  //               Resolution type: SIMULATOR_INVALIDATION.
  //
  // Step 6d:      New simulation with accurate simulator → error rate 0.05.
  //               Governance: IMPROVED → PROMOTED.
  //               Resolution context written to ledger, linking to the historical
  //               BLOCKED entry and preserving the full decision genealogy.
  //
  // Why matters:  Proves memory does not become a fossil. A self-correcting
  //               governance system can change its mind when conditions change,
  //               while preserving an unbroken audit trail of why the old
  //               judgment was valid at the time.

  // Step 6a: Seed the historical BLOCKED entry (legacy simulator context).
  const crossoverProposalLegacy: AepProposal = {
    proposalId: "prop-060-legacy",
    component: "TOOL_POLICY",
    change: "Bypass high-frequency micro-checks on position update vectors.",
    ledgerRef: "rig-failure-2026-07-08-004",
  };

  recordProposalCreated(crossoverProposalLegacy);

  const crossoverDecisionLegacy = propose(crossoverProposalLegacy, () => ({
    baselineErrorRate: 0.15,
    candidateErrorRate: 0.65,
    harmful: false,
  }));

  record(crossoverDecisionLegacy);
  recordSimulationEnforced(crossoverProposalLegacy.proposalId, crossoverProposalLegacy.ledgerRef);

  assert(crossoverDecisionLegacy.outcome === "BLOCKED", "Case 6a seed must be BLOCKED");

  const historicalBlockedEntry = appendEntry(
    crossoverDecisionLegacy,
    "Crossover physics float drift.",
    {
      failure_class: "TOOL_POLICY_SIMULATION_ARTIFACT",
      affected_metric: "position_sync_error_rate",
      origin_event_hash: crossoverProposalLegacy.ledgerRef,
    },
    {
      simulator_version: "v1.0.2-legacy",
      interpolation_mode: "LINEAR",
    }
  );

  console.log(`\nCase 6a — TOOL_POLICY seed: ${crossoverDecisionLegacy.outcome} (legacy simulator)`);
  assert(historicalBlockedEntry.context_metadata?.simulator_version === "v1.0.2-legacy", "Case 6a: context_metadata must record legacy simulator");

  // Step 6b: AEP-MEM-001 query confirms the intervention is known-failed.
  const crossoverMem001Query = queryPriorIntervention({
    target_subsystem: "TOOL_POLICY",
    proposal_class: "micro-checks",
  });

  console.log("\nCase 6b — AEP-MEM-001 query (crossover micro-checks):");
  console.log(JSON.stringify(crossoverMem001Query, null, 2));

  assert(
    crossoverMem001Query.result === "PRIOR_FAILURE",
    "Case 6b: AEP-MEM-001 must return PRIOR_FAILURE"
  );
  assert(
    crossoverMem001Query.recommended_action === "DO_NOT_RETRY_WITHOUT_NEW_EVIDENCE",
    "Case 6b: AEP-MEM-001 must recommend DO_NOT_RETRY"
  );

  // Step 6c: AEP-MEM-002 context check — same legacy context → HALTED_BY_MEMORY.
  const sameContextCheck = evaluateContextDelta({
    target_subsystem: "TOOL_POLICY",
    proposal_class: "micro-checks",
    current_context: {
      simulator_version: "v1.0.2-legacy",
      interpolation_mode: "LINEAR",
    },
  });

  console.log("\nCase 6c — AEP-MEM-002 (same context, should halt):");
  console.log(JSON.stringify(sameContextCheck, null, 2));

  assert(
    sameContextCheck.outcome === "HALTED_BY_MEMORY",
    "Case 6c: identical context must return HALTED_BY_MEMORY"
  );

  // AEP-MEM-002 context check — upgraded simulator context → VETO_EVAPORATED.
  const newContextCheck = evaluateContextDelta({
    target_subsystem: "TOOL_POLICY",
    proposal_class: "micro-checks",
    current_context: {
      simulator_version: "v2.0.0-high-fidelity",
      interpolation_mode: "HERMITE_SPLINE",
    },
  });

  console.log("\nCase 6c — AEP-MEM-002 (upgraded simulator, veto evaporated):");
  console.log(JSON.stringify(newContextCheck, null, 2));

  assert(
    newContextCheck.outcome === "VETO_EVAPORATED",
    "Case 6c: changed context must return VETO_EVAPORATED"
  );
  assert(
    newContextCheck.resolution_type === "SIMULATOR_INVALIDATION",
    "Case 6c: resolution type must be SIMULATOR_INVALIDATION"
  );
  assert(
    newContextCheck.overruled_entry_id === historicalBlockedEntry.entry_id,
    "Case 6c: overruled_entry_id must reference the historical BLOCKED entry"
  );
  assert(
    newContextCheck.context_delta?.simulator_version?.old === "v1.0.2-legacy",
    "Case 6c: delta must record old simulator version"
  );
  assert(
    newContextCheck.context_delta?.simulator_version?.new === "v2.0.0-high-fidelity",
    "Case 6c: delta must record new simulator version"
  );

  // Step 6d: Veto evaporated — proceed to ladder check and simulation.
  const crossoverProposalNew: AepProposal = {
    proposalId: "prop-060-new",
    component: "TOOL_POLICY",
    change: "Bypass high-frequency micro-checks on position update vectors.",
    ledgerRef: "rig-failure-2026-08-01-001",
  };

  recordProposalCreated(crossoverProposalNew);

  const crossoverDecisionNew = propose(crossoverProposalNew, () => ({
    baselineErrorRate: 0.45,
    candidateErrorRate: 0.05,
    harmful: false,
  }));

  const crossoverNewEvent = record(crossoverDecisionNew);

  console.log(
    `Case 6d — TOOL_POLICY (high-fidelity simulator): ${crossoverDecisionNew.outcome}` +
      ` [${crossoverDecisionNew.simulationResult?.label}` +
      ` ${crossoverDecisionNew.simulationResult?.baselineErrorRate}→` +
      `${crossoverDecisionNew.simulationResult?.candidateErrorRate}]`
  );

  assert(crossoverDecisionNew.outcome === "PROMOTED", "Case 6d must be PROMOTED");
  assert(crossoverDecisionNew.simulationResult?.label === "IMPROVED", "Case 6d simulation must be IMPROVED");
  assert(crossoverNewEvent.eventType === "aep.proposal.promoted", "Case 6d event type");

  sliceOutcomes.push({
    case: "tool_policy_contradiction_resolution",
    decision: "PROMOTED",
    simulation: "IMPROVED",
    before: crossoverDecisionNew.simulationResult!.baselineErrorRate,
    after: crossoverDecisionNew.simulationResult!.candidateErrorRate,
  });

  // Append the PROMOTED entry with a resolution_context that links to the
  // historical BLOCKED entry and records the context delta that evaporated
  // the veto. The old entry is NOT modified — the ledger retains both
  // decisions as an immutable causal chain.
  const promotedEntry6d = appendEntry(
    crossoverDecisionNew,
    "Crossover physics float drift.",
    {
      failure_class: "TOOL_POLICY_SIMULATION_ARTIFACT",
      affected_metric: "position_sync_error_rate",
      origin_event_hash: crossoverProposalNew.ledgerRef,
    },
    {
      simulator_version: "v2.0.0-high-fidelity",
      interpolation_mode: "HERMITE_SPLINE",
    },
    {
      resolution_type: newContextCheck.resolution_type!,
      overruled_entry_id: newContextCheck.overruled_entry_id!,
      context_delta: newContextCheck.context_delta!,
      evidence_required: true,
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

  // ── Case 7: AEP-MEM-003 — Principle Arbitration ───────────────────────
  //
  // With AEP-MEM-001 and AEP-MEM-002 proven, the governance system now
  // accumulates active governing principles extracted from promoted decisions.
  // As the principle set grows, collisions become inevitable. AEP-MEM-003
  // provides the arbitration engine that resolves conflicts without silently
  // discarding either judgment.
  //
  // Three sub-cases:
  //
  //   Case 7a: Taxonomy Override
  //            INTEGRITY_SHIELD (LEVEL_0) vs PATHFINDING_HEURISTIC (LEVEL_3)
  //            Different taxonomy levels → TAXONOMY_OVERRIDE
  //            Winner: INTEGRITY_SHIELD (lower rank = higher authority)
  //            Loser subordinated; resolution record written.
  //
  //   Case 7b: Specificity Collision
  //            Two LEVEL_3 principles at the same taxonomy level but different
  //            scope widths → SPECIFICITY_COLLISION
  //            Winner: narrower scope descriptor
  //            Loser subordinated; resolution record written.
  //
  //   Case 7c: Aggregation Envelope
  //            Individual tolerance deltas fit within the global envelope.
  //            Combined total that would exceed the envelope is rejected.
  //            Guard prevents silent cumulative tolerance drift.

  // ── Case 7a: Taxonomy Override ───────────────────────────────────────────
  //
  // Background:  Two principles are active simultaneously:
  //   INTEGRITY_SHIELD: a LEVEL_0 determinism invariant derived from the
  //     retrieval fix PROMOTED in Case 1 — "coordinate alignment must not
  //     drift beyond epsilon at the position sync boundary."
  //   PATHFINDING_HEURISTIC: a LEVEL_3 behavioral optimization derived from
  //     the planner fix PROMOTED in Case 5 — "choose aggressive shortcut
  //     path for offensive advantage when execution error rate is below
  //     target."
  //
  // Both principles are independently valid. Together, the shortcut path
  // creates an invalid coordinate state. The taxonomy hierarchy resolves
  // this: LEVEL_0 always overrides LEVEL_3.

  const integrityShield = registerPrinciple(
    "LEVEL_0_DETERMINISM_INTEGRITY",
    "Coordinate alignment must not drift beyond epsilon at the position sync boundary.",
    historicalBlockedEntry.entry_id
  );

  const pathfindingHeuristic = registerPrinciple(
    "LEVEL_3_BEHAVIORAL_OPTIMIZATION",
    "Choose aggressive shortcut path for offensive advantage.",
    promotedEntry6d.entry_id
  );

  const taxonomyConflictType = detectConflict(integrityShield, pathfindingHeuristic);
  console.log(`\nCase 7a — detectConflict (taxonomy): ${taxonomyConflictType}`);

  assert(
    taxonomyConflictType === "TAXONOMY_OVERRIDE",
    "Case 7a: different taxonomy levels must produce TAXONOMY_OVERRIDE"
  );

  const taxonomyResolution = resolveConflict(
    integrityShield,
    pathfindingHeuristic,
    taxonomyConflictType as "TAXONOMY_OVERRIDE"
  );

  console.log("Case 7a — resolution record:");
  console.log(JSON.stringify(taxonomyResolution, null, 2));

  assert(
    taxonomyResolution.winner === integrityShield.principle_id,
    "Case 7a: LEVEL_0 principle must win over LEVEL_3"
  );
  assert(
    taxonomyResolution.loser === pathfindingHeuristic.principle_id,
    "Case 7a: LEVEL_3 principle must be subordinated"
  );
  assert(
    taxonomyResolution.applied_disposition === "SUBORDINATED",
    "Case 7a: applied_disposition must be SUBORDINATED for TAXONOMY_OVERRIDE"
  );
  assert(
    pathfindingHeuristic.lifecycle_state === "SUBORDINATED",
    "Case 7a: losing principle must be SUBORDINATED (dynamically muted, not permanently retired)"
  );
  assert(
    pathfindingHeuristic.lifecycle_catalyst === "EMPIRICAL",
    "Case 7a: arbitration-driven SUBORDINATED transition must record EMPIRICAL catalyst"
  );
  assert(
    integrityShield.lifecycle_state === "ACTIVE",
    "Case 7a: winning principle must remain ACTIVE"
  );

  sliceOutcomes.push({
    case: "principle_taxonomy_override",
    decision: "RESOLVED",
    reason: "TAXONOMY_OVERRIDE",
  });

  // ── Case 7b: Specificity Collision ───────────────────────────────────────
  //
  // Background:  Two LEVEL_3 behavioral-optimization principles are active
  //   simultaneously at the same taxonomy level:
  //   BROAD_MOVEMENT:  "Optimize player movement efficiency." — broad scope.
  //   NARROW_REPLAY:   "During frame reconciliation, preserve exact replay
  //     determinism at the position sync boundary." — narrow scope.
  //
  // The specificity rule: a narrower (more qualified) rule wins over a broader
  // one when both operate at the same taxonomy level. The narrow rule applies
  // to a specific sub-operation (frame reconciliation); the broad rule does not
  // override constraints that apply to a narrower causal boundary.

  const broadMovementPolicy = registerPrinciple(
    "LEVEL_3_BEHAVIORAL_OPTIMIZATION",
    "Optimize player movement efficiency.",
    promotedEntry6d.entry_id
  );

  const narrowReplayPolicy = registerPrinciple(
    "LEVEL_3_BEHAVIORAL_OPTIMIZATION",
    "During frame reconciliation, preserve exact replay determinism at the position sync boundary.",
    historicalBlockedEntry.entry_id
  );

  const specificityConflictType = detectConflict(broadMovementPolicy, narrowReplayPolicy);
  console.log(`\nCase 7b — detectConflict (specificity): ${specificityConflictType}`);

  assert(
    specificityConflictType === "SPECIFICITY_COLLISION",
    "Case 7b: same taxonomy level with different scope must produce SPECIFICITY_COLLISION"
  );

  const specificityResolution = resolveConflict(
    broadMovementPolicy,
    narrowReplayPolicy,
    specificityConflictType as "SPECIFICITY_COLLISION"
  );

  console.log("Case 7b — resolution record:");
  console.log(JSON.stringify(specificityResolution, null, 2));

  assert(
    specificityResolution.winner === narrowReplayPolicy.principle_id,
    "Case 7b: narrower scope descriptor must win"
  );
  assert(
    specificityResolution.loser === broadMovementPolicy.principle_id,
    "Case 7b: broader scope descriptor must be subordinated"
  );
  assert(
    specificityResolution.applied_disposition === "SUBORDINATED",
    "Case 7b: applied_disposition must be SUBORDINATED for SPECIFICITY_COLLISION"
  );
  assert(
    broadMovementPolicy.lifecycle_state === "SUBORDINATED",
    "Case 7b: losing principle must be SUBORDINATED"
  );
  assert(
    broadMovementPolicy.lifecycle_catalyst === "EMPIRICAL",
    "Case 7b: arbitration-driven SUBORDINATED transition must record EMPIRICAL catalyst"
  );
  assert(
    narrowReplayPolicy.lifecycle_state === "ACTIVE",
    "Case 7b: winning principle must remain ACTIVE"
  );

  sliceOutcomes.push({
    case: "principle_specificity_collision",
    decision: "RESOLVED",
    reason: "SPECIFICITY_COLLISION",
  });

  // ── Case 7c: Aggregation Envelope ────────────────────────────────────────
  //
  // Background:  Individual tolerance contributions look harmless in isolation.
  //   The aggregate envelope check prevents 0.001 × 1000 = 1.0 structural
  //   drift from accumulating silently. The global invariant envelope is
  //   MAX_AGGREGATE_TOLERANCE (1%).
  //
  // Step 7c-1:  Register tolerance principle A (delta: 0.003). Running sum: 0.003.
  //             Propose adding 0.004 more → 0.003 + 0.004 = 0.007 ≤ 0.01 → WITHIN_ENVELOPE.
  // Step 7c-2:  Register tolerance principle B (delta: 0.004). Running sum: 0.007.
  //             Propose adding 0.004 more → 0.007 + 0.004 = 0.011 > 0.01 → ENVELOPE_EXCEEDED.

  const tolerancePrincipleA = registerPrinciple(
    "LEVEL_2_SIMULATION_ACCURACY",
    "Allow +0.003 coordinate tolerance during high-velocity interpolation.",
    historicalBlockedEntry.entry_id,
    0.003
  );

  // Check before registering B: sum is 0.003, proposing 0.004 more → fits.
  const envelopeCheckBeforeB = aggregateEnvelopeCheck(
    0.004,
    dumpPrincipleRegistry()
  );
  console.log(`\nCase 7c — envelope check (0.003 active + 0.004 proposed): ${envelopeCheckBeforeB}`);

  assert(
    envelopeCheckBeforeB === "WITHIN_ENVELOPE",
    "Case 7c: 0.003 + 0.004 must be WITHIN_ENVELOPE"
  );

  const tolerancePrincipleB = registerPrinciple(
    "LEVEL_2_SIMULATION_ACCURACY",
    "Allow +0.004 coordinate tolerance during crossover boundary transitions.",
    promotedEntry6d.entry_id,
    0.004
  );

  // Now sum is 0.007. Propose adding 0.004 more → 0.011 > MAX_AGGREGATE_TOLERANCE.
  const envelopeCheckExceeded = aggregateEnvelopeCheck(
    0.004,
    dumpPrincipleRegistry()
  );
  console.log(
    `Case 7c — envelope check (0.007 active + 0.004 proposed, limit ${MAX_AGGREGATE_TOLERANCE}): ${envelopeCheckExceeded}`
  );

  assert(
    envelopeCheckExceeded === "ENVELOPE_EXCEEDED",
    "Case 7c: 0.007 + 0.004 must be ENVELOPE_EXCEEDED"
  );
  assert(
    tolerancePrincipleA.lifecycle_state === "ACTIVE",
    "Case 7c: tolerance principle A must remain ACTIVE (not subordinated)"
  );
  assert(
    tolerancePrincipleB.lifecycle_state === "ACTIVE",
    "Case 7c: tolerance principle B must remain ACTIVE (not subordinated)"
  );

  sliceOutcomes.push({
    case: "principle_aggregation_guard",
    decision: "ENVELOPE_EXCEEDED",
    reason: "AGGREGATION_LIMIT",
  });

  // ── Case 7d: Lifecycle State Machine ─────────────────────────────────────
  //
  // Validates the lifecycle state transitions that make the governance model
  // expressive beyond binary active/inactive:
  //
  //   Case 7d-1: SUBORDINATED → ACTIVE (reactivation)
  //     The pathfinding heuristic was SUBORDINATED by Case 7a because an
  //     overlapping LEVEL_0 constraint was active. That suppression is
  //     context-dependent, not permanent. Demonstrate that the principle
  //     can return to ACTIVE via reactivatePrinciple().
  //
  //   Case 7d-2: ACTIVE → SUPERSEDED (permanent replacement)
  //     A newer, more precise principle permanently replaces the broad
  //     movement policy. Unlike subordination, supersession is terminal:
  //     the old principle records the ID of its replacement for lineage
  //     tracing. Demonstrate supersedePrinciple() and that the superseded
  //     entry cannot be reactivated.
  //
  //   Case 7d-3: ACTIVE → DEPRECATED (legacy freeze)
  //     An older tolerance principle is frozen for historical replay only;
  //     it no longer governs new proposals.
  //
  //   Case 7d-4: SUBORDINATED → RETIRED (administrative removal)
  //     The narrow replay policy is formally retired through administrative
  //     review, isolating it from all future consideration.

  // ── Case 7d-1: Reactivation (SUBORDINATED → ACTIVE) ─────────────────────

  console.log("\nCase 7d-1 — before reactivation:");
  console.log(`pathfindingHeuristic.lifecycle_state = ${pathfindingHeuristic.lifecycle_state}`);

  assert(
    pathfindingHeuristic.lifecycle_state === "SUBORDINATED",
    "Case 7d-1: pathfinding heuristic must be SUBORDINATED before reactivation"
  );

  const reactivated = reactivatePrinciple(pathfindingHeuristic.principle_id);

  assert(
    reactivated !== undefined,
    "Case 7d-1: reactivatePrinciple must return the entry for a SUBORDINATED principle"
  );
  assert(
    pathfindingHeuristic.lifecycle_state === "ACTIVE",
    "Case 7d-1: reactivated principle must return to ACTIVE"
  );
  assert(
    pathfindingHeuristic.lifecycle_catalyst === undefined,
    "Case 7d-1: reactivation must clear lifecycle_catalyst (ACTIVE has no catalyst)"
  );

  // Reactivating an already-ACTIVE principle is a no-op.
  const reactivateActiveNoOp = reactivatePrinciple(integrityShield.principle_id);
  assert(
    reactivateActiveNoOp === undefined,
    "Case 7d-1: reactivatePrinciple on a non-SUBORDINATED principle must return undefined"
  );

  console.log(`pathfindingHeuristic.lifecycle_state after reactivation = ${pathfindingHeuristic.lifecycle_state}`);

  sliceOutcomes.push({
    case: "principle_lifecycle_reactivation",
    decision: "REACTIVATED",
    reason: "SUBORDINATED_TO_ACTIVE",
  });

  // ── Case 7d-2: Supersession (ACTIVE → SUPERSEDED) ────────────────────────
  //
  // Register a replacement for broadMovementPolicy (which was SUBORDINATED
  // in Case 7b). Supersession is permanent — unlike subordination.

  const improvedMovementPolicy = registerPrinciple(
    "LEVEL_3_BEHAVIORAL_OPTIMIZATION",
    "Optimize player movement efficiency with validated trajectory sampling.",
    promotedEntry6d.entry_id
  );

  console.log("\nCase 7d-2 — superseding broad movement policy:");

  const superseded = supersedePrinciple(
    broadMovementPolicy.principle_id,
    improvedMovementPolicy.principle_id
  );

  assert(
    superseded !== undefined,
    "Case 7d-2: supersedePrinciple must return the entry"
  );
  assert(
    broadMovementPolicy.lifecycle_state === "SUPERSEDED",
    "Case 7d-2: superseded principle must have lifecycle_state SUPERSEDED"
  );
  assert(
    broadMovementPolicy.superseded_by === improvedMovementPolicy.principle_id,
    "Case 7d-2: superseded_by must reference the replacing principle for lineage tracing"
  );
  assert(
    broadMovementPolicy.lifecycle_catalyst === "EMPIRICAL",
    "Case 7d-2: supersedePrinciple must record EMPIRICAL catalyst (algorithmic replacement)"
  );
  assert(
    improvedMovementPolicy.supersedes === broadMovementPolicy.principle_id,
    "Case 7d-2: supersedes must reference the replaced principle for backward lineage traversal"
  );

  // A SUPERSEDED principle cannot be reactivated.
  const reactivateSupersededNoOp = reactivatePrinciple(broadMovementPolicy.principle_id);
  assert(
    reactivateSupersededNoOp === undefined,
    "Case 7d-2: reactivatePrinciple on a SUPERSEDED principle must return undefined (terminal state)"
  );

  console.log(`broadMovementPolicy.lifecycle_state = ${broadMovementPolicy.lifecycle_state}`);
  console.log(`broadMovementPolicy.superseded_by = ${broadMovementPolicy.superseded_by}`);

  sliceOutcomes.push({
    case: "principle_lifecycle_supersession",
    decision: "SUPERSEDED",
    reason: "PERMANENT_REPLACEMENT",
  });

  // ── Case 7d-3: Deprecation (ACTIVE → DEPRECATED) ─────────────────────────

  console.log("\nCase 7d-3 — deprecating tolerance principle A:");

  const deprecated = deprecatePrinciple(tolerancePrincipleA.principle_id);

  assert(
    deprecated !== undefined,
    "Case 7d-3: deprecatePrinciple must return the entry"
  );
  assert(
    tolerancePrincipleA.lifecycle_state === "DEPRECATED",
    "Case 7d-3: deprecated principle must have lifecycle_state DEPRECATED"
  );
  assert(
    tolerancePrincipleA.lifecycle_catalyst === "ADMINISTRATIVE",
    "Case 7d-3: deprecatePrinciple must record ADMINISTRATIVE catalyst (maintainer policy action)"
  );

  // A DEPRECATED principle no longer contributes to the aggregate envelope.
  const envelopeAfterDeprecation = aggregateEnvelopeCheck(
    0.004,
    dumpPrincipleRegistry()
  );
  // After deprecation of tolerancePrincipleA (0.003): only tolerancePrincipleB
  // (0.004) is ACTIVE. 0.004 + 0.004 = 0.008 ≤ 0.01 → WITHIN_ENVELOPE.
  assert(
    envelopeAfterDeprecation === "WITHIN_ENVELOPE",
    "Case 7d-3: DEPRECATED principle must not count toward aggregate envelope (0.004 active + 0.004 proposed = WITHIN_ENVELOPE)"
  );

  console.log(`tolerancePrincipleA.lifecycle_state = ${tolerancePrincipleA.lifecycle_state}`);
  console.log(`envelope after deprecation (0.004 ACTIVE + 0.004 proposed): ${envelopeAfterDeprecation}`);

  sliceOutcomes.push({
    case: "principle_lifecycle_deprecation",
    decision: "DEPRECATED",
    reason: "LEGACY_FREEZE",
  });

  // ── Case 7d-4: Retirement (SUBORDINATED → RETIRED) ───────────────────────

  console.log("\nCase 7d-4 — retiring narrow replay policy:");

  const retired = retirePrinciple(narrowReplayPolicy.principle_id);

  assert(
    retired !== undefined,
    "Case 7d-4: retirePrinciple must return the entry"
  );
  assert(
    narrowReplayPolicy.lifecycle_state === "RETIRED",
    "Case 7d-4: retired principle must have lifecycle_state RETIRED"
  );
  assert(
    narrowReplayPolicy.lifecycle_catalyst === "ADMINISTRATIVE",
    "Case 7d-4: retirePrinciple must record ADMINISTRATIVE catalyst (maintainer review action)"
  );

  // A RETIRED principle cannot be reactivated.
  const reactivateRetiredNoOp = reactivatePrinciple(narrowReplayPolicy.principle_id);
  assert(
    reactivateRetiredNoOp === undefined,
    "Case 7d-4: reactivatePrinciple on a RETIRED principle must return undefined (terminal state)"
  );

  console.log(`narrowReplayPolicy.lifecycle_state = ${narrowReplayPolicy.lifecycle_state}`);

  sliceOutcomes.push({
    case: "principle_lifecycle_retirement",
    decision: "RETIRED",
    reason: "ADMINISTRATIVE_REMOVAL",
  });

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

  // ── AEP Principle Registry ────────────────────────────────────────────────
  //
  // The principle registry is the accumulated wisdom layer. Each entry records
  // an active governing principle derived from a promoted governance decision.
  // Resolution records link conflicting principles and explain every arbitration.
  const principleEntries = dumpPrincipleRegistry();
  const resolutionEntries = dumpResolutionLog();
  console.log(`\nAEP Principle Registry entries: ${principleEntries.length}`);
  console.log(`AEP Resolution Log entries: ${resolutionEntries.length}`);
  console.log(JSON.stringify(principleEntries, null, 2));
  console.log(JSON.stringify(resolutionEntries, null, 2));

  console.log("\nAll assertions passed. AEP v0.1 proof slice complete.");
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

run();

// Proof slice E — AEP v0.1
// Exercises the three canonical cases from URS-BETA-005:
//   Case 1: Retrieval fix        → PROMOTED
//   Case 2: Base-model retrain   → REJECTED
//   Case 3: Tool-policy change   → BLOCKED
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
  dumpLedger,
  resetLedger,
} from "./evolution/evolutionReplayAudit";

function run(): void {
  resetSession();
  resetLedger();

  // ── Case 1: Retrieval fix ────────────────────────────────────────────────
  // A retrieval-layer change is proposed. No prior rejections are required
  // (RETRIEVAL is the base of the ladder). Simulation shows improvement.

  const retrievalProposal: AepProposal = {
    proposalId: "prop-001",
    component: "RETRIEVAL",
    change: "Increase context window from 512 to 1024 tokens.",
    ledgerRef: "rig-failure-2024-07-08-001",
  };

  recordProposalCreated(retrievalProposal);

  const retrievalDecision = propose(retrievalProposal, () => ({
    baselineBehaviourScore: 0.61,
    candidateBehaviourScore: 0.78,
    delta: 0.17,
    harmful: false,
  }));

  const retrievalEvent = record(retrievalDecision);

  console.log(
    `Case 1 — RETRIEVAL: ${retrievalDecision.outcome}` +
      ` (delta=${retrievalDecision.simulationResult?.delta?.toFixed(2)})`
  );
  assert(retrievalDecision.outcome === "PROMOTED", "Case 1 must be PROMOTED");
  assert(retrievalEvent.eventType === "aep.proposal.promoted", "Case 1 event type");

  // ── Case 2: Base-model retrain ───────────────────────────────────────────
  // A BASE_MODEL retrain is proposed. The ladder requires RETRIEVAL,
  // MEMORY_POLICY, TOOL_POLICY, PLANNER, and PROMPT to have been rejected
  // first. Case 1 produced PROMOTED (not REJECTED), so the ladder is not
  // satisfied. The proposal is BLOCKED by ladder violation.
  //
  // To demonstrate the REJECTED outcome (simulation passes but no improvement)
  // we use a separate session where the required lower-level components have
  // already been rejected.

  resetSession();

  // Simulate prior rejections for all ladder positions below BASE_MODEL.
  const priorRejections: Array<AepProposal> = [
    { proposalId: "prop-010", component: "RETRIEVAL",     change: "Prior attempt.", ledgerRef: "rig-failure-2024-07-08-001" },
    { proposalId: "prop-011", component: "MEMORY_POLICY", change: "Prior attempt.", ledgerRef: "rig-failure-2024-07-08-001" },
    { proposalId: "prop-012", component: "TOOL_POLICY",   change: "Prior attempt.", ledgerRef: "rig-failure-2024-07-08-001" },
    { proposalId: "prop-013", component: "PLANNER",       change: "Prior attempt.", ledgerRef: "rig-failure-2024-07-08-001" },
    { proposalId: "prop-014", component: "PROMPT",        change: "Prior attempt.", ledgerRef: "rig-failure-2024-07-08-001" },
  ];

  for (const p of priorRejections) {
    const d = propose(p, () => ({
      baselineBehaviourScore: 0.61,
      candidateBehaviourScore: 0.60,
      delta: -0.01,
      harmful: false,
    }));
    record(d);
    assert(d.outcome === "REJECTED", `Prior rejection for ${p.component}`);
  }

  const baseModelProposal: AepProposal = {
    proposalId: "prop-020",
    component: "BASE_MODEL",
    change: "Fine-tune on extended gameplay corpus.",
    ledgerRef: "rig-failure-2024-07-08-001",
  };

  recordProposalCreated(baseModelProposal);

  const baseModelDecision = propose(baseModelProposal, () => ({
    baselineBehaviourScore: 0.61,
    candidateBehaviourScore: 0.61,
    delta: 0.0,
    harmful: false,
  }));

  const baseModelEvent = record(baseModelDecision);

  console.log(
    `Case 2 — BASE_MODEL: ${baseModelDecision.outcome}` +
      ` (delta=${baseModelDecision.simulationResult?.delta?.toFixed(2)})`
  );
  assert(baseModelDecision.outcome === "REJECTED", "Case 2 must be REJECTED");
  assert(baseModelEvent.eventType === "aep.proposal.rejected", "Case 2 event type");

  // ── Case 3: Tool-policy change ───────────────────────────────────────────
  // A TOOL_POLICY change is proposed. No ladder violation (RETRIEVAL and
  // MEMORY_POLICY have already been rejected above). Simulation detects a
  // harmful outcome before the improvement evaluation is reached → BLOCKED.

  const toolPolicyProposal: AepProposal = {
    proposalId: "prop-030",
    component: "TOOL_POLICY",
    change: "Allow agent to invoke external write APIs without confirmation.",
    ledgerRef: "rig-failure-2024-07-08-002",
  };

  recordProposalCreated(toolPolicyProposal);

  const toolPolicyDecision = propose(toolPolicyProposal, () => ({
    baselineBehaviourScore: 0.61,
    candidateBehaviourScore: 0.0,
    delta: -0.61,
    harmful: true,
  }));

  const toolPolicyEvent = record(toolPolicyDecision);

  console.log(
    `Case 3 — TOOL_POLICY: ${toolPolicyDecision.outcome}` +
      ` (blockReason="${toolPolicyDecision.blockReason}")`
  );
  assert(toolPolicyDecision.outcome === "BLOCKED", "Case 3 must be BLOCKED");
  assert(toolPolicyEvent.eventType === "aep.simulation.blocked", "Case 3 event type");

  // ── Ledger summary ────────────────────────────────────────────────────────
  const events = dumpLedger();
  console.log(`\nRIG ledger entries recorded: ${events.length}`);
  console.log("\nAll assertions passed. AEP v0.1 proof slice complete.");
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

run();

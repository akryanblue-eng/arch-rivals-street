// Agent Evolution Protocol — AEP v0.1
// Governance boundary: No Direct Failure → Mutation (URS-BETA-005)

export type EvolvableComponent =
  | "RETRIEVAL"
  | "MEMORY_POLICY"
  | "TOOL_POLICY"
  | "PLANNER"
  | "PROMPT"
  | "BASE_MODEL";

export type AepOutcome = "PROMOTED" | "REJECTED" | "BLOCKED";

export interface AepProposal {
  proposalId: string;
  component: EvolvableComponent;
  change: string;
  ledgerRef: string;
}

export interface SimulationResult {
  baselineBehaviourScore: number;
  candidateBehaviourScore: number;
  delta: number;
  harmful: boolean;
}

export interface AepDecision {
  proposal: AepProposal;
  outcome: AepOutcome;
  simulationResult?: SimulationResult;
  blockReason?: string;
}

// Ordered from smallest to largest intervention.
const LADDER: EvolvableComponent[] = [
  "RETRIEVAL",
  "MEMORY_POLICY",
  "TOOL_POLICY",
  "PLANNER",
  "PROMPT",
  "BASE_MODEL",
];

// Tracks which components have been simulated and rejected in the current
// evolution session. A component at position N is only eligible once all
// components at positions < N have been rejected.
const rejectedComponents: Set<EvolvableComponent> = new Set();

function ladderIndex(component: EvolvableComponent): number {
  return LADDER.indexOf(component);
}

function requiredPriorRejections(
  component: EvolvableComponent
): EvolvableComponent[] {
  const idx = ladderIndex(component);
  return LADDER.slice(0, idx) as EvolvableComponent[];
}

function validateLadder(proposal: AepProposal): string | null {
  const required = requiredPriorRejections(proposal.component);
  const missing = required.filter((c) => !rejectedComponents.has(c));
  if (missing.length === 0) return null;
  return (
    `Ladder violation: ${proposal.component} requires prior rejection of ` +
    `[${missing.join(", ")}]`
  );
}

// Runs a deterministic counterfactual of the proposed change against the
// RIG replay window identified by ledgerRef. Returns a SimulationResult.
// In production this delegates to the replay harness; here it accepts an
// injected runner so the proof slice can drive it directly.
export function runSimulation(
  _proposal: AepProposal,
  runner: () => SimulationResult
): SimulationResult {
  return runner();
}

export function propose(
  proposal: AepProposal,
  simulationRunner: () => SimulationResult
): AepDecision {
  // 1. Validate ladder precedence.
  const violation = validateLadder(proposal);
  if (violation !== null) {
    return {
      proposal,
      outcome: "BLOCKED",
      blockReason: violation,
    };
  }

  // 2. Run simulation.
  const sim = runSimulation(proposal, simulationRunner);

  // 3. If the simulation detected a harmful outcome, block immediately.
  if (sim.harmful) {
    return {
      proposal,
      outcome: "BLOCKED",
      simulationResult: sim,
      blockReason: "Simulation detected harmful outcome.",
    };
  }

  // 4. Evaluate: did the proposed change improve observed behaviour?
  if (sim.delta <= 0) {
    rejectedComponents.add(proposal.component);
    return {
      proposal,
      outcome: "REJECTED",
      simulationResult: sim,
    };
  }

  // 5. Promote.
  return {
    proposal,
    outcome: "PROMOTED",
    simulationResult: sim,
  };
}

// Exported for test / proof-slice use.
export function resetSession(): void {
  rejectedComponents.clear();
}

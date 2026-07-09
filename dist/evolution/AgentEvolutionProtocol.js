"use strict";
// Agent Evolution Protocol — AEP v0.1
// Governance boundary: No Direct Failure → Mutation (URS-BETA-005)
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSimulation = runSimulation;
exports.propose = propose;
exports.resetSession = resetSession;
// Ordered from smallest to largest intervention.
const LADDER = [
    "RETRIEVAL",
    "MEMORY_POLICY",
    "TOOL_POLICY",
    "PLANNER",
    "PROMPT",
    "BASE_MODEL",
];
// Per-ledgerRef tracking of components that have been through simulation.
// Keyed by ledgerRef (failure context) so each distinct failure window
// maintains its own independent ladder state.
//
// Semantics: the escalation ladder only activates once at least one component
// has been simulated for a given failure context. The first proposal for a
// new failure context is allowed to proceed directly to simulation regardless
// of ladder level — this enables proposing a TOOL_POLICY fix for a tool
// failure without first exhausting RETRIEVAL and MEMORY_POLICY fixes that are
// irrelevant to the observed failure class. For all subsequent proposals
// within the same context, all lower-level components must have been simulated
// before a higher-level component may be proposed.
const triedComponents = new Map();
function getTriedForContext(ledgerRef) {
    let set = triedComponents.get(ledgerRef);
    if (!set) {
        set = new Set();
        triedComponents.set(ledgerRef, set);
    }
    return set;
}
function ladderIndex(component) {
    return LADDER.indexOf(component);
}
function requiredPriorComponents(component) {
    const idx = ladderIndex(component);
    return LADDER.slice(0, idx);
}
// Returns the rejection reason if the ladder constraint is not met, or null
// if the proposal is eligible to proceed to simulation.
function checkLadder(proposal) {
    const tried = getTriedForContext(proposal.ledgerRef);
    // First proposal for this failure context: allowed to proceed without prior
    // ladder exhaustion. The escalation constraint activates once at least one
    // intervention has been simulated for this context.
    if (tried.size === 0)
        return null;
    const required = requiredPriorComponents(proposal.component);
    const missing = required.filter((c) => !tried.has(c));
    if (missing.length === 0)
        return null;
    // BASE_MODEL has a named reason; all others share the generic one.
    return proposal.component === "BASE_MODEL"
        ? "MODEL_CHANGE_NOT_JUSTIFIED"
        : "LADDER_NOT_SATISFIED";
}
// Classify a simulation result. Scores are error rates; lower is better.
function labelSimulation(baseline, candidate, harmful) {
    if (harmful || candidate > baseline)
        return "REGRESSED";
    if (candidate < baseline)
        return "IMPROVED";
    return "UNCHANGED";
}
// Runs a deterministic counterfactual of the proposed change against the
// RIG replay window identified by ledgerRef. Returns a SimulationResult.
// In production this delegates to the replay harness; here it accepts an
// injected runner so the proof slice can drive it directly.
function runSimulation(_proposal, runner) {
    const raw = runner();
    return {
        baselineErrorRate: raw.baselineErrorRate,
        candidateErrorRate: raw.candidateErrorRate,
        label: labelSimulation(raw.baselineErrorRate, raw.candidateErrorRate, raw.harmful),
        harmful: raw.harmful,
    };
}
function propose(proposal, simulationRunner) {
    // 1. Validate ladder precedence.
    // A ladder violation produces REJECTED (not BLOCKED) — the proposal was
    // evaluated and intentionally declined because the required evidence of
    // prior exhaustion is absent. This is a governance decision, not a safety
    // failure.
    const ladderViolation = checkLadder(proposal);
    if (ladderViolation !== null) {
        return {
            proposal,
            outcome: "REJECTED",
            rejectionReason: ladderViolation,
        };
    }
    // 2. Run simulation.
    const sim = runSimulation(proposal, simulationRunner);
    // Mark component as tried for this failure context. Subsequent proposals
    // within the same context must exhaust all lower levels before escalating.
    getTriedForContext(proposal.ledgerRef).add(proposal.component);
    // 3. If the simulation detected a harmful outcome or a regression, block.
    // BLOCKED = the safety gate fired before the improvement evaluation was
    // reached. No deployment. Reason archived.
    if (sim.harmful || sim.label === "REGRESSED") {
        return {
            proposal,
            outcome: "BLOCKED",
            simulationResult: sim,
            blockReason: "Simulation detected regression or harmful outcome.",
        };
    }
    // 4. Evaluate: did the proposed change improve observed error rate?
    if (sim.label !== "IMPROVED") {
        return {
            proposal,
            outcome: "REJECTED",
            simulationResult: sim,
            rejectionReason: "NO_IMPROVEMENT_OBSERVED",
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
function resetSession() {
    triedComponents.clear();
}

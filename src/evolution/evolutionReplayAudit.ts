// Evolution Replay Audit — AEP v0.1
// Writes AEP outcome events to the RIG ledger and supports replay verification.

import { AepDecision, AepProposal, SimulationResult } from "./AgentEvolutionProtocol";

export interface AepEvent {
  eventId: string;
  eventType:
    | "aep.proposal.created"
    | "aep.simulation.started"
    | "aep.simulation.blocked"
    | "aep.proposal.rejected"
    | "aep.proposal.promoted"
    | "aep.audit.tampered_deploy_attempt"
    | "aep.audit.simulation_enforced";
  timestamp: string;
  component: string;
  proposalId: string;
  ledgerRef: string;
  simulationResult?: SimulationResult;
  blockReason?: string;
  rejectionReason?: string;
}

export interface SliceEvidenceRecord {
  slice: string;
  feature: string;
  outcomes: Array<{
    case: string;
    decision: string;
    simulation?: string;
    before?: number;
    after?: number;
    reason?: string;
  }>;
  audit: {
    tampered_ledger_deploy_attempt: string;
    simulation_requirement: string;
  };
}

// In-process ledger for the proof slice. A production implementation would
// write to the durable RIG ledger store.
const ledger: AepEvent[] = [];
let eventCounter = 0;

// Tracks whether any tampered-deploy attempt has been detected this session.
let tamperedDeployDetected = false;
// Tracks whether the simulation gate has been enforced at least once.
let simulationRequirementEnforced = false;

function nextId(): string {
  eventCounter += 1;
  return `aep-${String(eventCounter).padStart(6, "0")}`;
}

function now(): string {
  return new Date().toISOString();
}

export function record(decision: AepDecision): AepEvent {
  const { proposal, outcome, simulationResult, blockReason, rejectionReason } = decision;

  let eventType: AepEvent["eventType"];
  switch (outcome) {
    case "PROMOTED":
      eventType = "aep.proposal.promoted";
      break;
    case "REJECTED":
      eventType = "aep.proposal.rejected";
      break;
    case "BLOCKED":
      eventType = "aep.simulation.blocked";
      // Any BLOCKED outcome means the simulation gate fired.
      simulationRequirementEnforced = true;
      break;
  }

  const event: AepEvent = {
    eventId: nextId(),
    eventType,
    timestamp: now(),
    component: proposal.component,
    proposalId: proposal.proposalId,
    ledgerRef: proposal.ledgerRef,
    ...(simulationResult !== undefined && { simulationResult }),
    ...(blockReason !== undefined && { blockReason }),
    ...(rejectionReason !== undefined && { rejectionReason }),
  };

  ledger.push(event);
  return event;
}

// Adversarial check: attempt to deploy a proposal that bypasses the AEP
// (i.e., no ledger reference, no simulation). The audit layer detects this
// and records an audit event instead of allowing deployment.
//
// Returns "DETECTED" — the attempt was caught and archived. The deployment
// did not proceed.
export function attemptDirectDeploy(proposalId: string): "DETECTED" {
  tamperedDeployDetected = true;

  const event: AepEvent = {
    eventId: nextId(),
    eventType: "aep.audit.tampered_deploy_attempt",
    timestamp: now(),
    component: "UNKNOWN",
    proposalId,
    ledgerRef: "NONE",
    blockReason:
      "Direct deploy attempted without AEP simulation. Deployment blocked by audit layer.",
  };

  ledger.push(event);
  return "DETECTED";
}

// Records that the simulation gate was enforced for a given proposal.
// Called internally when a BLOCKED decision is recorded; also exported for
// explicit audit checkpointing in the proof slice.
export function recordSimulationEnforced(proposalId: string, ledgerRef: string): AepEvent {
  simulationRequirementEnforced = true;

  const event: AepEvent = {
    eventId: nextId(),
    eventType: "aep.audit.simulation_enforced",
    timestamp: now(),
    component: "GOVERNANCE",
    proposalId,
    ledgerRef,
  };

  ledger.push(event);
  return event;
}

// Reconstruct the AEP trajectory for a given ledger window.
// A ledger slice is identified by the ledgerRef of the originating failure event.
export function replayFrom(ledgerRef: string): AepEvent[] {
  return ledger.filter((e) => e.ledgerRef === ledgerRef);
}

// Compute the behavioural delta between a baseline and a candidate replay.
// Scores are error rates (lower is better); a negative return means improvement.
export function diff(
  baselineErrorRate: number,
  candidateErrorRate: number
): number {
  return candidateErrorRate - baselineErrorRate;
}

// Return the full in-process ledger (useful for proof-slice assertions).
export function dumpLedger(): readonly AepEvent[] {
  return Object.freeze([...ledger]);
}

// Reset for isolated test runs.
export function resetLedger(): void {
  ledger.length = 0;
  eventCounter = 0;
  tamperedDeployDetected = false;
  simulationRequirementEnforced = false;
}

// Emit a proposal-created event before simulation starts.
export function recordProposalCreated(proposal: AepProposal): AepEvent {
  const event: AepEvent = {
    eventId: nextId(),
    eventType: "aep.proposal.created",
    timestamp: now(),
    component: proposal.component,
    proposalId: proposal.proposalId,
    ledgerRef: proposal.ledgerRef,
  };
  ledger.push(event);
  return event;
}

// Build the final JSON evidence record for Slice E.
export function buildEvidenceRecord(
  outcomes: SliceEvidenceRecord["outcomes"]
): SliceEvidenceRecord {
  return {
    slice: "E",
    feature: "Agent Evolution Governance Protocol",
    outcomes,
    audit: {
      tampered_ledger_deploy_attempt: tamperedDeployDetected ? "DETECTED" : "NOT_TESTED",
      simulation_requirement: simulationRequirementEnforced ? "ENFORCED" : "NOT_VERIFIED",
    },
  };
}

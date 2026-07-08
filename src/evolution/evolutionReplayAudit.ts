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
    | "aep.proposal.promoted";
  timestamp: string;
  component: string;
  proposalId: string;
  ledgerRef: string;
  simulationResult?: SimulationResult;
  blockReason?: string;
}

// In-process ledger for the proof slice. A production implementation would
// write to the durable RIG ledger store.
const ledger: AepEvent[] = [];
let eventCounter = 0;

function nextId(): string {
  eventCounter += 1;
  return `aep-${String(eventCounter).padStart(6, "0")}`;
}

function now(): string {
  return new Date().toISOString();
}

export function record(decision: AepDecision): AepEvent {
  const { proposal, outcome, simulationResult, blockReason } = decision;

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
// Returns a positive number when the candidate outperforms the baseline.
export function diff(
  baselineScore: number,
  candidateScore: number
): number {
  return candidateScore - baselineScore;
}

// Return the full in-process ledger (useful for proof-slice assertions).
export function dumpLedger(): readonly AepEvent[] {
  return Object.freeze([...ledger]);
}

// Reset for isolated test runs.
export function resetLedger(): void {
  ledger.length = 0;
  eventCounter = 0;
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

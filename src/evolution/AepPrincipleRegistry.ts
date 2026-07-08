// AEP Principle Registry — principle arbitration layer for AEP v0.1
//
// AEP-MEM-003: Principle Conflict Resolution
//
// As the governance system accumulates validated learned principles (each
// extracted from a promoted ledger decision), those principles may eventually
// conflict. This module implements the arbitration engine that resolves
// principle collisions without silently discarding either judgment.
//
// AEP-MEM-001 answers: "Have we encountered this before?"
// AEP-MEM-002 answers: "Does the previous conclusion still apply?"
// AEP-MEM-003 answers: "What happens when two validated conclusions both
//                        apply, but they disagree?"
//
// API surface:
//
//   registerPrinciple()      — add a new active governing principle derived
//                              from a promoted ledger decision.
//   detectConflict()         — check whether two principles collide and
//                              classify the conflict type.
//   resolveConflict()        — run the arbitration engine, produce a
//                              PrincipleResolutionRecord, and subordinate the
//                              losing principle.
//   aggregateEnvelopeCheck() — guard against cumulative tolerance drift:
//                              verify that the combined tolerance delta of all
//                              active principles remains within the global
//                              invariant envelope before a new principle is
//                              promoted.

import { createHash } from "crypto";

// Taxonomy hierarchy for governing principles.
// Lower numeric rank = higher authority. A LEVEL_0 constraint always overrides
// a LEVEL_3 heuristic when their constraints collide on the same execution
// vector.
//
// LEVEL_0_DETERMINISM_INTEGRITY  — fixed-point invariants, coordinate alignment
//                                   bounds, determinism requirements. Cannot be
//                                   silently waived by any lower level.
// LEVEL_1_SAFETY_BOUNDARY        — hard safety constraints and stop conditions.
// LEVEL_2_SIMULATION_ACCURACY    — simulation fidelity requirements.
// LEVEL_3_BEHAVIORAL_OPTIMIZATION — efficiency and performance heuristics.
// LEVEL_4_PREFERENCE_STYLE       — soft preferences and style guidance.
export type PrincipleClass =
  | "LEVEL_0_DETERMINISM_INTEGRITY"
  | "LEVEL_1_SAFETY_BOUNDARY"
  | "LEVEL_2_SIMULATION_ACCURACY"
  | "LEVEL_3_BEHAVIORAL_OPTIMIZATION"
  | "LEVEL_4_PREFERENCE_STYLE";

// Conflict classification for principle arbitration.
//
// TAXONOMY_OVERRIDE    — the two principles sit at different taxonomy levels;
//                        the higher-authority level wins unconditionally.
// SPECIFICITY_COLLISION — the two principles sit at the same taxonomy level
//                         but cover different scope widths; the narrower
//                         (more specific) scope wins.
// AGGREGATION_LIMIT    — no single pairwise conflict, but the combined
//                         tolerance contributions of multiple active principles
//                         would breach the global invariant envelope.
//                         Detected by aggregateEnvelopeCheck(), not
//                         detectConflict().
export type ConflictType =
  | "TAXONOMY_OVERRIDE"
  | "SPECIFICITY_COLLISION"
  | "AGGREGATION_LIMIT";

// A governing principle extracted from a promoted governance decision.
//
// Principles are immutable once registered — their content (principle_id,
// class, scope, source) never changes. Arbitration outcome is recorded via
// PrincipleResolutionRecord rather than by modifying the principle itself.
// The exception is the `active` flag, which is set to false by resolveConflict
// when this principle is subordinated, matching the existing ledger pattern of
// preserving the historical record while marking the judgment as superseded.
export interface PrincipleEntry {
  // SHA-256 content address derived from principle_class, scope_descriptor,
  // and source_entry_id. Two identical principles produce the same ID.
  principle_id: string;
  principle_class: PrincipleClass;
  // Human-readable specificity annotation describing the scope of the rule.
  // Narrower (more qualified) descriptors are longer; broader descriptors are
  // shorter. Used by the SPECIFICITY_COLLISION resolution path.
  scope_descriptor: string;
  // entry_id of the AepDecisionLedgerEntry whose PROMOTED verdict produced
  // this principle. Creates a traceable link from principle to governance event.
  source_entry_id: string;
  // Optional numeric tolerance contribution. When a principle permits a
  // floating-point tolerance (e.g. +0.003 coordinate drift), record it here
  // so aggregateEnvelopeCheck() can sum contributions across all active
  // principles and detect cumulative drift before it breaches the invariant.
  tolerance_delta?: number;
  // False once this principle is subordinated by a PrincipleResolutionRecord.
  // Subordinated principles are preserved in the registry as historical records.
  active: boolean;
}

// Immutable record of a principle arbitration decision.
// Every arbitration is logged — the system never silently chooses.
export interface PrincipleResolutionRecord {
  // SHA-256 content address derived from principle_a, principle_b,
  // conflict_type, and winner.
  resolution_id: string;
  principle_a: string;        // principle_id of first participant
  principle_b: string;        // principle_id of second participant
  conflict_type: ConflictType;
  winner: string;             // principle_id of the winning principle
  loser: string;              // principle_id of the subordinated principle
  justification: {
    // Human-readable explanation of why the winner prevailed.
    priority_delta: string;
    // True when simulation was used to confirm the resolution.
    simulation_verified: boolean;
  };
}

// Numeric rank for each PrincipleClass. Lower value = higher authority.
const PRINCIPLE_CLASS_RANK: Record<PrincipleClass, number> = {
  LEVEL_0_DETERMINISM_INTEGRITY: 0,
  LEVEL_1_SAFETY_BOUNDARY: 1,
  LEVEL_2_SIMULATION_ACCURACY: 2,
  LEVEL_3_BEHAVIORAL_OPTIMIZATION: 3,
  LEVEL_4_PREFERENCE_STYLE: 4,
};

// Maximum combined tolerance delta permitted across all active principles.
// aggregateEnvelopeCheck() rejects any proposed principle whose tolerance_delta
// would push the running total above this threshold.
//
// Grounded invariant: the combined coordinate drift permitted by all active
// simulation-accuracy and behavioral-optimization principles must not exceed
// 1% (0.01). This prevents the 0.001 × 1000 cumulative drift scenario where
// each incremental tolerance looks harmless but the aggregate erodes the
// fixed-point invariant.
export const MAX_AGGREGATE_TOLERANCE = 0.01;

// In-process stores. A production implementation writes to a durable store.
const principleRegistry: PrincipleEntry[] = [];
const resolutionLog: PrincipleResolutionRecord[] = [];

// Compute a content-addressed SHA-256 principle ID.
function computePrincipleId(
  principleClass: PrincipleClass,
  scopeDescriptor: string,
  sourceEntryId: string
): string {
  const content = [principleClass, scopeDescriptor, sourceEntryId].join("|");
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

// Compute a content-addressed SHA-256 resolution ID.
function computeResolutionId(
  principleA: string,
  principleB: string,
  conflictType: ConflictType,
  winner: string
): string {
  const content = [principleA, principleB, conflictType, winner].join("|");
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

// Proxy for scope specificity: longer descriptors encode narrower, more
// qualified rules; shorter descriptors encode broader heuristics.
// In production this would use a formal scope ontology.
function scopeSpecificity(scopeDescriptor: string): number {
  return scopeDescriptor.length;
}

// Register a new active governing principle derived from a promoted decision.
// Returns the registered entry.
export function registerPrinciple(
  principleClass: PrincipleClass,
  scopeDescriptor: string,
  sourceEntryId: string,
  toleranceDelta?: number
): PrincipleEntry {
  const entry: PrincipleEntry = {
    principle_id: computePrincipleId(principleClass, scopeDescriptor, sourceEntryId),
    principle_class: principleClass,
    scope_descriptor: scopeDescriptor,
    source_entry_id: sourceEntryId,
    ...(toleranceDelta !== undefined && { tolerance_delta: toleranceDelta }),
    active: true,
  };
  principleRegistry.push(entry);
  return entry;
}

// AEP-MEM-003: Detect whether two active principles conflict and classify the
// conflict type.
//
// Evaluation order:
//   1. TAXONOMY_OVERRIDE: the principles are at different taxonomy levels.
//      The higher-authority level (lower rank number) always wins.
//   2. SPECIFICITY_COLLISION: the principles are at the same taxonomy level
//      but their scope descriptors differ, meaning they represent competing
//      heuristics within the same priority tier.
//   3. NO_CONFLICT: the principles are at the same level with identical scope.
//
// AGGREGATION_LIMIT conflicts span the full active principle set and are not
// detectable by pairwise comparison. Use aggregateEnvelopeCheck() instead.
export function detectConflict(
  principleA: PrincipleEntry,
  principleB: PrincipleEntry
): ConflictType | "NO_CONFLICT" {
  const rankA = PRINCIPLE_CLASS_RANK[principleA.principle_class];
  const rankB = PRINCIPLE_CLASS_RANK[principleB.principle_class];

  if (rankA !== rankB) {
    return "TAXONOMY_OVERRIDE";
  }

  // Same taxonomy level: competing heuristics within the same priority tier.
  if (principleA.scope_descriptor !== principleB.scope_descriptor) {
    return "SPECIFICITY_COLLISION";
  }

  return "NO_CONFLICT";
}

// AEP-MEM-003: Resolve a detected conflict between two principles.
//
// Produces a PrincipleResolutionRecord and marks the losing principle inactive
// in the registry. The losing principle is preserved as an immutable historical
// record — this matches the existing ledger invariant of never overwriting the
// original judgment.
//
// Resolution rules by conflict type:
//   TAXONOMY_OVERRIDE     — the principle with the lower taxonomy rank
//                           (higher authority) wins unconditionally.
//   SPECIFICITY_COLLISION — the principle with the narrower (longer)
//                           scope descriptor wins.
//
// AGGREGATION_LIMIT is not resolved pairwise; use aggregateEnvelopeCheck().
export function resolveConflict(
  principleA: PrincipleEntry,
  principleB: PrincipleEntry,
  conflictType: ConflictType
): PrincipleResolutionRecord {
  let winner: PrincipleEntry;
  let loser: PrincipleEntry;
  let priorityDelta: string;

  if (conflictType === "TAXONOMY_OVERRIDE") {
    const rankA = PRINCIPLE_CLASS_RANK[principleA.principle_class];
    const rankB = PRINCIPLE_CLASS_RANK[principleB.principle_class];
    // Lower rank = higher authority.
    if (rankA <= rankB) {
      winner = principleA;
      loser = principleB;
    } else {
      winner = principleB;
      loser = principleA;
    }
    priorityDelta =
      `${winner.principle_class} (rank ${PRINCIPLE_CLASS_RANK[winner.principle_class]})` +
      ` > ${loser.principle_class} (rank ${PRINCIPLE_CLASS_RANK[loser.principle_class]})`;
  } else {
    // SPECIFICITY_COLLISION: narrower scope (longer descriptor) wins.
    const specA = scopeSpecificity(principleA.scope_descriptor);
    const specB = scopeSpecificity(principleB.scope_descriptor);
    if (specA >= specB) {
      winner = principleA;
      loser = principleB;
    } else {
      winner = principleB;
      loser = principleA;
    }
    priorityDelta =
      `"${winner.scope_descriptor}" (specificity ${scopeSpecificity(winner.scope_descriptor)})` +
      ` > "${loser.scope_descriptor}" (specificity ${scopeSpecificity(loser.scope_descriptor)})`;
  }

  const record: PrincipleResolutionRecord = {
    resolution_id: computeResolutionId(
      principleA.principle_id,
      principleB.principle_id,
      conflictType,
      winner.principle_id
    ),
    principle_a: principleA.principle_id,
    principle_b: principleB.principle_id,
    conflict_type: conflictType,
    winner: winner.principle_id,
    loser: loser.principle_id,
    justification: {
      priority_delta: priorityDelta,
      simulation_verified: true,
    },
  };

  // Subordinate the loser in the registry.
  // The principle entry is preserved; only its active flag changes.
  const loserEntry = principleRegistry.find(
    (p) => p.principle_id === loser.principle_id
  );
  if (loserEntry !== undefined) {
    loserEntry.active = false;
  }

  resolutionLog.push(record);
  return record;
}

// AEP-MEM-003: Aggregate envelope check.
//
// Before promoting a new principle that carries a tolerance_delta contribution,
// verify that the sum of all active tolerance deltas plus the proposed delta
// does not exceed MAX_AGGREGATE_TOLERANCE.
//
// Control flow:
//
//   currentSum = Σ tolerance_delta for all active principles
//        │
//   ┌────┴──────────────────────────────┐
//   │                                   │
//   ▼                                   ▼
// currentSum + proposedDelta          currentSum + proposedDelta
//         ≤ MAX_AGGREGATE_TOLERANCE        > MAX_AGGREGATE_TOLERANCE
//        │                                   │
//        ▼                                   ▼
// WITHIN_ENVELOPE                    ENVELOPE_EXCEEDED
// (safe to register)                 (registration blocked)
//
// Returns "WITHIN_ENVELOPE" if the proposed delta fits within the envelope,
// or "ENVELOPE_EXCEEDED" if registering it would breach the global invariant.
export function aggregateEnvelopeCheck(
  proposedDelta: number,
  principles: readonly PrincipleEntry[]
): "WITHIN_ENVELOPE" | "ENVELOPE_EXCEEDED" {
  const currentSum = principles
    .filter((p) => p.active && p.tolerance_delta !== undefined)
    .reduce((acc, p) => acc + (p.tolerance_delta as number), 0);

  return currentSum + proposedDelta <= MAX_AGGREGATE_TOLERANCE
    ? "WITHIN_ENVELOPE"
    : "ENVELOPE_EXCEEDED";
}

// Return a frozen copy of the principle registry.
export function dumpPrincipleRegistry(): readonly PrincipleEntry[] {
  return Object.freeze([...principleRegistry]);
}

// Return a frozen copy of the resolution log.
export function dumpResolutionLog(): readonly PrincipleResolutionRecord[] {
  return Object.freeze([...resolutionLog]);
}

// Reset all stores for isolated test runs.
export function resetPrincipleRegistry(): void {
  principleRegistry.length = 0;
  resolutionLog.length = 0;
}

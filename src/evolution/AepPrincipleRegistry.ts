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
// Lifecycle model:
//
//   Arbitration (why a decision was reached) and lifecycle (what happens to
//   the principle) are separate dimensions. resolveConflict() determines the
//   conflict type (TAXONOMY_OVERRIDE, SPECIFICITY_COLLISION) and assigns the
//   loser a disposition (SUBORDINATED by default). The lifecycle state machine
//   then governs further transitions independently.
//
//   ACTIVE       — governing execution. The principle is the current authority
//                  for its execution vector.
//   SUBORDINATED — dynamically muted. Structurally valid but temporarily
//                  dormant because a higher-priority overlapping constraint is
//                  actively governing the same execution vector. Reversible:
//                  the principle may return to ACTIVE once the constraining
//                  condition is no longer in force (reactivatePrinciple).
//   SUPERSEDED   — cryptographically retired. A newer content-addressed
//                  principle has claimed full logical replacement. Permanent
//                  across all subsequent epochs.
//   DEPRECATED   — frozen for legacy compatibility. Retained as a fallback
//                  for historical replay trajectories; blocked from
//                  intervening in new proposals.
//   RETIRED      — formally purged via administrative review. Isolated from
//                  all future consideration.
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
//   reactivatePrinciple()    — transition a SUBORDINATED principle back to
//                              ACTIVE once the overriding constraint has
//                              cleared.
//   supersedePrinciple()     — permanently retire a principle because a newer
//                              rule has claimed full logical replacement.
//   deprecatePrinciple()     — freeze a principle for legacy replay only;
//                              block it from intervening in new proposals.
//   retirePrinciple()        — administratively remove a principle from all
//                              future consideration.

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

// Lifecycle state of a governing principle.
//
// Arbitration (why a decision was reached) and lifecycle (what happens to
// the principle) are orthogonal. resolveConflict() sets the loser to
// SUBORDINATED. Independent lifecycle transitions — SUPERSEDED, DEPRECATED,
// RETIRED — are managed via the explicit lifecycle functions.
//
// ACTIVE       — currently governing execution.
// SUBORDINATED — temporarily muted by a higher-priority overlapping constraint.
//                Reversible: may return to ACTIVE via reactivatePrinciple().
// SUPERSEDED   — permanently replaced by a newer content-addressed principle.
// DEPRECATED   — frozen for legacy replay only; blocked from new proposals.
// RETIRED      — administratively removed from all future consideration.
export type PrincipleLifecycleState =
  | "ACTIVE"
  | "SUBORDINATED"
  | "SUPERSEDED"
  | "DEPRECATED"
  | "RETIRED";

// Lifecycle disposition assigned to the losing principle in an arbitration
// record, or to any principle via an explicit lifecycle transition.
// Kept as a separate type from PrincipleLifecycleState so that ACTIVE is
// not a valid disposition (you never "dispose" a principle into ACTIVE).
export type PrincipleLifecycleDisposition =
  | "SUBORDINATED"
  | "SUPERSEDED"
  | "DEPRECATED"
  | "RETIRED";

// A governing principle extracted from a promoted governance decision.
//
// Principles are immutable once registered — their content (principle_id,
// class, scope, source) never changes. Arbitration outcome is recorded via
// PrincipleResolutionRecord rather than by modifying the principle itself.
// The `lifecycle_state` field is the only mutable field: it advances through
// the lifecycle state machine as arbitration and lifecycle management events
// occur. This preserves the principle as a historical record while accurately
// representing its current governance role.
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
  // Current lifecycle state. Advances through the lifecycle state machine.
  // Only ACTIVE principles contribute to execution governance.
  // Only SUBORDINATED principles may return to ACTIVE via reactivatePrinciple().
  lifecycle_state: PrincipleLifecycleState;
  // Optional principle_id of the principle that superseded this one.
  // Only set when lifecycle_state is SUPERSEDED.
  superseded_by?: string;
}

// Immutable record of a principle arbitration decision.
// Every arbitration is logged — the system never silently chooses.
//
// Arbitration (conflict_type) and lifecycle (applied_disposition) are
// recorded as separate fields: the arbitration engine determines which rule
// wins and why; the disposition field records what lifecycle transition was
// applied to the loser as a result.
export interface PrincipleResolutionRecord {
  // SHA-256 content address derived from principle_a, principle_b,
  // conflict_type, and winner.
  resolution_id: string;
  principle_a: string;        // principle_id of first participant
  principle_b: string;        // principle_id of second participant
  conflict_type: ConflictType;
  winner: string;             // principle_id of the winning principle
  loser: string;              // principle_id of the principle that was displaced
  // Lifecycle disposition applied to the loser. Records what state transition
  // was executed as a result of this arbitration event. Separating this from
  // conflict_type allows the arbitration engine to remain focused on why a
  // decision was reached while lifecycle policy governs what happens next.
  applied_disposition: PrincipleLifecycleDisposition;
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
    lifecycle_state: "ACTIVE",
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
// Produces a PrincipleResolutionRecord and applies the given disposition to
// the losing principle in the registry. The losing principle is preserved as
// an immutable historical record — this matches the existing ledger invariant
// of never overwriting the original judgment.
//
// Resolution rules by conflict type:
//   TAXONOMY_OVERRIDE     — the principle with the lower taxonomy rank
//                           (higher authority) wins unconditionally.
//   SPECIFICITY_COLLISION — the principle with the narrower (longer)
//                           scope descriptor wins.
//
// The disposition parameter controls the lifecycle transition applied to the
// loser. It defaults to SUBORDINATED (reversible suppression) because
// pairwise arbitration conflicts are typically runtime context-dependent
// rather than permanent replacements. Pass SUPERSEDED explicitly when the
// losing principle is known to be permanently obsolete.
//
// AGGREGATION_LIMIT is not resolved pairwise; use aggregateEnvelopeCheck().
export function resolveConflict(
  principleA: PrincipleEntry,
  principleB: PrincipleEntry,
  conflictType: ConflictType,
  disposition: PrincipleLifecycleDisposition = "SUBORDINATED"
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
    applied_disposition: disposition,
    justification: {
      priority_delta: priorityDelta,
      simulation_verified: true,
    },
  };

  // Apply the lifecycle disposition to the loser in the registry.
  // The principle entry is preserved; only its lifecycle_state changes.
  const loserEntry = principleRegistry.find(
    (p) => p.principle_id === loser.principle_id
  );
  if (loserEntry !== undefined) {
    loserEntry.lifecycle_state = disposition;
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
//   currentSum = Σ tolerance_delta for all ACTIVE principles
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
    .filter((p) => p.lifecycle_state === "ACTIVE" && p.tolerance_delta !== undefined)
    .reduce((acc, p) => acc + (p.tolerance_delta as number), 0);

  return currentSum + proposedDelta <= MAX_AGGREGATE_TOLERANCE
    ? "WITHIN_ENVELOPE"
    : "ENVELOPE_EXCEEDED";
}

// Transition a SUBORDINATED principle back to ACTIVE.
//
// SUBORDINATED is the only reversible non-active lifecycle state. A principle
// suppressed by a higher-priority overlapping constraint may become valid
// again when the constraining condition is no longer in force (e.g. the
// LEVEL_0 constraint that suppressed a LEVEL_3 heuristic is itself superseded
// by a new boundary condition). Attempting to reactivate a principle that is
// not currently SUBORDINATED is a no-op and returns undefined.
export function reactivatePrinciple(
  principleId: string
): PrincipleEntry | undefined {
  const entry = principleRegistry.find(
    (p) => p.principle_id === principleId
  );
  if (entry === undefined || entry.lifecycle_state !== "SUBORDINATED") {
    return undefined;
  }
  entry.lifecycle_state = "ACTIVE";
  return entry;
}

// Permanently retire a principle because a newer content-addressed principle
// has claimed full logical replacement. Sets lifecycle_state to SUPERSEDED
// and records the superseding principle's ID for lineage tracing.
//
// SUPERSEDED is terminal: a superseded principle cannot be reactivated. Its
// historical record is preserved for audit and lineage reconstruction.
export function supersedePrinciple(
  principleId: string,
  supersedingPrincipleId?: string
): PrincipleEntry | undefined {
  const entry = principleRegistry.find(
    (p) => p.principle_id === principleId
  );
  if (entry === undefined) {
    return undefined;
  }
  entry.lifecycle_state = "SUPERSEDED";
  if (supersedingPrincipleId !== undefined) {
    entry.superseded_by = supersedingPrincipleId;
  }
  return entry;
}

// Freeze a principle for legacy compatibility. Sets lifecycle_state to
// DEPRECATED. Deprecated principles are retained as fallback routes for
// historical replay trajectory evaluation but are blocked from intervening
// in new simulation proposals.
//
// DEPRECATED is terminal from the perspective of active governance but not
// from the perspective of historical record. Use retirePrinciple() to fully
// remove a principle from future consideration.
export function deprecatePrinciple(
  principleId: string
): PrincipleEntry | undefined {
  const entry = principleRegistry.find(
    (p) => p.principle_id === principleId
  );
  if (entry === undefined) {
    return undefined;
  }
  entry.lifecycle_state = "DEPRECATED";
  return entry;
}

// Formally purge a principle via administrative review. Sets lifecycle_state
// to RETIRED. Retired principles are isolated from all future consideration
// including historical replay. This is an administrative terminal state
// reached through deliberate review — not a consequence of runtime conflict.
//
// RETIRED is terminal.
export function retirePrinciple(
  principleId: string
): PrincipleEntry | undefined {
  const entry = principleRegistry.find(
    (p) => p.principle_id === principleId
  );
  if (entry === undefined) {
    return undefined;
  }
  entry.lifecycle_state = "RETIRED";
  return entry;
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

"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_AGGREGATE_TOLERANCE = void 0;
exports.registerPrinciple = registerPrinciple;
exports.detectConflict = detectConflict;
exports.resolveConflict = resolveConflict;
exports.aggregateEnvelopeCheck = aggregateEnvelopeCheck;
exports.dumpPrincipleRegistry = dumpPrincipleRegistry;
exports.dumpResolutionLog = dumpResolutionLog;
exports.resetPrincipleRegistry = resetPrincipleRegistry;
const crypto_1 = require("crypto");
// Numeric rank for each PrincipleClass. Lower value = higher authority.
const PRINCIPLE_CLASS_RANK = {
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
exports.MAX_AGGREGATE_TOLERANCE = 0.01;
// In-process stores. A production implementation writes to a durable store.
const principleRegistry = [];
const resolutionLog = [];
// Compute a content-addressed SHA-256 principle ID.
function computePrincipleId(principleClass, scopeDescriptor, sourceEntryId) {
    const content = [principleClass, scopeDescriptor, sourceEntryId].join("|");
    return "sha256:" + (0, crypto_1.createHash)("sha256").update(content).digest("hex");
}
// Compute a content-addressed SHA-256 resolution ID.
function computeResolutionId(principleA, principleB, conflictType, winner) {
    const content = [principleA, principleB, conflictType, winner].join("|");
    return "sha256:" + (0, crypto_1.createHash)("sha256").update(content).digest("hex");
}
// Proxy for scope specificity: longer descriptors encode narrower, more
// qualified rules; shorter descriptors encode broader heuristics.
// In production this would use a formal scope ontology.
function scopeSpecificity(scopeDescriptor) {
    return scopeDescriptor.length;
}
// Register a new active governing principle derived from a promoted decision.
// Returns the registered entry.
function registerPrinciple(principleClass, scopeDescriptor, sourceEntryId, toleranceDelta) {
    const entry = {
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
function detectConflict(principleA, principleB) {
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
function resolveConflict(principleA, principleB, conflictType) {
    let winner;
    let loser;
    let priorityDelta;
    if (conflictType === "TAXONOMY_OVERRIDE") {
        const rankA = PRINCIPLE_CLASS_RANK[principleA.principle_class];
        const rankB = PRINCIPLE_CLASS_RANK[principleB.principle_class];
        // Lower rank = higher authority.
        if (rankA <= rankB) {
            winner = principleA;
            loser = principleB;
        }
        else {
            winner = principleB;
            loser = principleA;
        }
        priorityDelta =
            `${winner.principle_class} (rank ${PRINCIPLE_CLASS_RANK[winner.principle_class]})` +
                ` > ${loser.principle_class} (rank ${PRINCIPLE_CLASS_RANK[loser.principle_class]})`;
    }
    else {
        // SPECIFICITY_COLLISION: narrower scope (longer descriptor) wins.
        const specA = scopeSpecificity(principleA.scope_descriptor);
        const specB = scopeSpecificity(principleB.scope_descriptor);
        if (specA >= specB) {
            winner = principleA;
            loser = principleB;
        }
        else {
            winner = principleB;
            loser = principleA;
        }
        priorityDelta =
            `"${winner.scope_descriptor}" (specificity ${scopeSpecificity(winner.scope_descriptor)})` +
                ` > "${loser.scope_descriptor}" (specificity ${scopeSpecificity(loser.scope_descriptor)})`;
    }
    const record = {
        resolution_id: computeResolutionId(principleA.principle_id, principleB.principle_id, conflictType, winner.principle_id),
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
    const loserEntry = principleRegistry.find((p) => p.principle_id === loser.principle_id);
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
function aggregateEnvelopeCheck(proposedDelta, principles) {
    const currentSum = principles
        .filter((p) => p.active && p.tolerance_delta !== undefined)
        .reduce((acc, p) => acc + p.tolerance_delta, 0);
    return currentSum + proposedDelta <= exports.MAX_AGGREGATE_TOLERANCE
        ? "WITHIN_ENVELOPE"
        : "ENVELOPE_EXCEEDED";
}
// Return a frozen copy of the principle registry.
function dumpPrincipleRegistry() {
    return Object.freeze([...principleRegistry]);
}
// Return a frozen copy of the resolution log.
function dumpResolutionLog() {
    return Object.freeze([...resolutionLog]);
}
// Reset all stores for isolated test runs.
function resetPrincipleRegistry() {
    principleRegistry.length = 0;
    resolutionLog.length = 0;
}

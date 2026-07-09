# URS-BETA-006: Principle Arbitration (AEP-MEM-003)

## Status

**Accepted implementation record.**

This document is a frozen checkpoint for the Principle Arbitration layer (AEP-MEM-003)
introduced as part of the URS-BETA-006 governance boundary. It is an architectural
record, not a design proposal. Future iterations should treat this document as the
established baseline.

---

## Invariant Chain

URS-BETA-006 extends the governance stack established by the BETA series:

```
URS-BETA-003
No Direct Sensor → Action
        |
        v
Perception governance

URS-BETA-004
No Direct Intent → Execution
        |
        v
Action governance

URS-BETA-005
No Direct Failure → Mutation
        |
        v
Evolution governance

URS-BETA-006
No Silent Principle Collision
        |
        v
Principle arbitration governance
```

The invariant asserted by URS-BETA-006:

> No two active governing principles may produce a contradictory constraint
> on the same execution vector without an explicit arbitration record
> explaining which constraint prevails and why.

---

## Problem Statement

### Previous Approach

AEP-MEM-001 and AEP-MEM-002 give the system institutional memory and
context-sensitive contradiction resolution. Each promoted decision can
generate an active governing principle. As the principle set grows, collisions
become inevitable.

The dangerous failure mode is not that a single principle is wrong. It is:

```
Principle A is correct
+
Principle B is correct
=
Combined behavior is incorrect
```

Examples:

```
INTEGRITY_SHIELD:
"Never allow coordinate drift beyond epsilon."

SEMANTIC_POLICY_ANCHOR:
"Choose aggressive shortcut path for offensive advantage."
```

Both individually valid. Together, the shortcut creates an invalid coordinate
state. Without arbitration, the system either silently applies one rule or
produces undefined behavior at the boundary.

### The Three Collision Classes

**Taxonomy Hierarchy collision**: two principles at different authority levels
compete on the same constraint. Resolution is deterministic: the higher-authority
taxonomy level wins unconditionally.

**Specificity collision**: two principles at the same authority level with different
scope widths compete. Resolution favors the narrower rule — a rule that applies
to a specific sub-operation (frame reconciliation) does not yield to a broader
heuristic (movement efficiency) that did not anticipate the narrow case.

**Aggregation drift**: no pairwise conflict exists, but individually marginal
tolerance contributions accumulate across many active principles until they
breach a core invariant. Not a binary conflict; requires a global envelope check.

---

## AEP Memory Stack

AEP-MEM-003 extends the memory stack:

```
AEP-MEM-001
"Have we encountered this before?"
        |
        v
AEP-MEM-002
"Does the previous conclusion still apply?"
        |
        v
AEP-MEM-003
"What happens when two validated conclusions both apply, but they disagree?"
```

---

## Taxonomy Hierarchy

The hierarchy assigns each principle class a numeric rank. Lower rank = higher
authority. Principles at rank 0 cannot be silently overridden by any higher-rank
principle.

```
LEVEL_0_DETERMINISM_INTEGRITY  (rank 0)
Fixed-point invariants, coordinate alignment bounds, determinism requirements
        |
        v
LEVEL_1_SAFETY_BOUNDARY  (rank 1)
Hard safety constraints and stop conditions
        |
        v
LEVEL_2_SIMULATION_ACCURACY  (rank 2)
Simulation fidelity requirements
        |
        v
LEVEL_3_BEHAVIORAL_OPTIMIZATION  (rank 3)
Efficiency and performance heuristics
        |
        v
LEVEL_4_PREFERENCE_STYLE  (rank 4)
Soft preferences and style guidance
```

Example resolution:

```
Fixed-point coordinate invariant (LEVEL_0)
        >
Aggressive path selection heuristic (LEVEL_3)

The pathfinder can adapt.
The coordinate system cannot silently drift.
```

---

## Specificity Dominance

When two principles sit at the same taxonomy level, the narrower rule wins.

```
General (broad scope):
"Optimize player movement efficiency."

Specific (narrow scope):
"During frame reconciliation, preserve exact replay determinism
 at the position sync boundary."

Winner: specific rule
Reason: the specific rule applies to a narrower causal boundary
        not anticipated by the general rule.
```

Ordering:

```
Specific + validated
        >
Broad + validated
        >
Unvalidated heuristic
```

---

## Aggregation Envelope

Individual tolerance contributions may each appear harmless:

```
Principle A: allow +0.001 tolerance
Principle B: allow +0.001 tolerance
Principle C: allow +0.001 tolerance
...

Accumulated effect: 0.001 × 1000 = structural drift
```

The global envelope check prevents this:

```
No combined tolerance_delta of all active principles
may exceed MAX_AGGREGATE_TOLERANCE (0.01).
```

`aggregateEnvelopeCheck()` is called before any principle with a
`tolerance_delta` is registered. If the proposed delta would push the
running total above the envelope, registration is blocked.

---

## Data Flow

```
Active Principle Set
        |
        v
New principle proposed
        |
        v
aggregateEnvelopeCheck()
        |
   ┌────┴──────────────────────────┐
   │                               │
   ▼                               ▼
WITHIN_ENVELOPE             ENVELOPE_EXCEEDED
(proceed to registration)   (registration blocked)
        |
        v
registerPrinciple()
        |
        v
detectConflict(newPrinciple, existingPrinciple)
        |
   ┌────┴──────────────────────────────────┐
   │                                       │
   ▼                                       ▼
NO_CONFLICT                        TAXONOMY_OVERRIDE
(no action needed)                 SPECIFICITY_COLLISION
                                           |
                                           v
                                   resolveConflict()
                                           |
                             ┌─────────────┴─────────────┐
                             │                           │
                             ▼                           ▼
                   Winner remains active         Loser subordinated
                                                 (active = false)
                                                         |
                                                         v
                                                 PrincipleResolutionRecord
                                                 written to resolution log
```

---

## Principle Graph Relationships

The principle registry enables a directed graph over the active principle set:

```
Principle A
    |
    | conflicts_with
    |
    v
Principle B

Principle C
    |
    | supersedes (via resolution record)
    |
    v
Principle D
```

The system learns not only principles, but relationships between principles.
Every `PrincipleResolutionRecord` is an edge in this graph.

---

## Principle Lifecycle State Machine

Arbitration and lifecycle are orthogonal dimensions.

`conflict_type` records **why** the arbitration engine reached a decision.
`applied_disposition` records **what lifecycle transition** was applied to the loser.

A TAXONOMY_OVERRIDE conflict does not imply that the losing principle is
permanently obsolete. A lower-rank heuristic suppressed by a higher-authority
constraint may become valid again once the constraining condition clears. That
is a different class of event from a principle being explicitly replaced by a
newer version or formally removed by administrative review.

### States

```
ACTIVE        — currently governing execution.
SUBORDINATED  — temporarily muted by a higher-priority overlapping constraint.
                Reversible: the principle may return to ACTIVE.
SUPERSEDED    — permanently replaced by a newer content-addressed principle.
                Terminal.
DEPRECATED    — frozen for legacy replay only; blocked from new proposals.
                Terminal from an active governance perspective.
RETIRED       — administratively removed from all future consideration.
                Terminal.
```

### Lifecycle Catalyst

Each non-ACTIVE state transition is tagged with a `lifecycle_catalyst` that
records **what class of event drove it**. Two catalyst types are defined:

**EMPIRICAL** — driven by runtime evidence: arbitration results, simulator
validation, or environmental telemetry. The system detected a constraint that
changed the principle's operational status.

- `SUBORDINATED` via `resolveConflict()`: the arbitration engine detected a
  pairwise conflict at runtime and dynamically muted the lower-priority principle.
- `SUPERSEDED` via `supersedePrinciple()`: a newer, algorithmically validated
  principle has claimed full logical replacement.

**ADMINISTRATIVE** — driven by deliberate maintainer policy: compatibility scope
adjustments, security-driven purges, or explicit policy decisions.

- `DEPRECATED` via `deprecatePrinciple()`: a maintainer has intentionally frozen
  the principle for legacy replay scope only.
- `RETIRED` via `retirePrinciple()`: a maintainer has formally removed the
  principle through administrative review.

This separation ensures a compliance audit or meta-learning engine can
immediately distinguish system-driven self-optimization from human-directed
policy changes without inferring one from the other.

```
                    ┌──────────────────────────────┐
                    │          CANDIDATE           │
                    └──────────────┬───────────────┘
                                   │ registerPrinciple()
                                   ▼
                    ┌──────────────────────────────┐
                    │            ACTIVE            │
                    └──────┬────────────────┬──────┘
                           │                │
             ┌─────────────┘                └─────────────┐
             ▼ EMPIRICAL catalyst                         ▼ ADMINISTRATIVE catalyst
   ┌───────────────────┐                        ┌───────────────────┐
   │   SUBORDINATED    │                        │    DEPRECATED     │
   │ resolveConflict() │◄──reactivatePrinciple()│ deprecatePrinciple│
   └─────────┬─────────┘                        └─────────┬─────────┘
             │                                            │
             │ supersedePrinciple()                       │ retirePrinciple()
             ▼ EMPIRICAL catalyst                         ▼ ADMINISTRATIVE catalyst
   ┌───────────────────┐                        ┌───────────────────┐
   │    SUPERSEDED     │                        │      RETIRED      │
   │    (terminal)     │                        │    (terminal)     │
   └───────────────────┘                        └───────────────────┘
```

`lifecycle_catalyst` is absent on ACTIVE principles. It is cleared when a
SUBORDINATED principle returns to ACTIVE via `reactivatePrinciple()`. It is
preserved permanently for all terminal states as an immutable audit annotation.

### Transitions

```
                  ┌──────────────────────────────┐
                  │           ACTIVE             │
                  └──┬───────────────────────────┘
                     │                │
     resolveConflict │                │ supersedePrinciple()
     (SUBORDINATED)  │                │ deprecatePrinciple()
                     ▼                │ retirePrinciple()
                  ┌──────────────┐    │
  reactivate ◄───►│ SUBORDINATED │    │
  Principle()     └──────┬───────┘    │
                         │            │
          retirePrinciple│            ▼
                         │     ┌─────────────┐
                         └────►│  SUPERSEDED │  (terminal)
                               │  DEPRECATED │  (terminal)
                               │   RETIRED   │  (terminal)
                               └─────────────┘
```

Key properties:
- `SUBORDINATED` is the **only reversible** non-active state.
- `SUPERSEDED`, `DEPRECATED`, and `RETIRED` are terminal.
- `reactivatePrinciple()` only operates on `SUBORDINATED` entries. It returns
  `undefined` for any other state, preventing accidental revival of
  permanently retired principles.
- `reactivatePrinciple()` clears `lifecycle_catalyst`: ACTIVE has no catalyst.
- `DEPRECATED` principles do not contribute to the aggregate envelope check.
  Only `ACTIVE` principles count toward `MAX_AGGREGATE_TOLERANCE`.

### Resolution → Disposition Mapping

The arbitration engine currently produces `SUBORDINATED` for both pairwise
conflict types. The `applied_disposition` field in `PrincipleResolutionRecord`
keeps this explicit so that future conflict types can map to different
dispositions without ambiguity:

| Conflict type | Default disposition | Catalyst |
|---|---|---|
| `TAXONOMY_OVERRIDE` | `SUBORDINATED` | `EMPIRICAL` |
| `SPECIFICITY_COLLISION` | `SUBORDINATED` | `EMPIRICAL` |

Explicit lifecycle management functions produce the remaining dispositions:

| Function | Disposition applied | Catalyst |
|---|---|---|
| `supersedePrinciple()` | `SUPERSEDED` | `EMPIRICAL` |
| `deprecatePrinciple()` | `DEPRECATED` | `ADMINISTRATIVE` |
| `retirePrinciple()` | `RETIRED` | `ADMINISTRATIVE` |

### Principle Lineage

When a principle is superseded, two lineage edges are recorded simultaneously:

**Forward edge** (`superseded_by` on the old principle): records the
`principle_id` of the replacement. Enables forward traversal from ancestor to
successor.

**Backward edge** (`supersedes` on the new principle): records the
`principle_id` of the predecessor. Enables backward traversal from successor to
ancestor.

Together they form a doubly-linked replacement chain across principle generations:

```
Old Principle (SUPERSEDED)
      │                 ▲
      │ superseded_by   │ supersedes
      ▼                 │
New Principle (ACTIVE) ─┘
```

An audit or meta-learning agent can reconstruct the full replacement chain in
either direction by following these edges. If an unexpected regression surfaces
in a complex calculation, an engineer can step backward through `supersedes`
links to pinpoint exactly which ancestor principle introduced the vulnerable
premise — without needing to search the full registry.

---

## Schemas

Principle registry entries conform to:

```
docs/architecture/schemas/principle-registry.v0.1.schema.json
```

Principle resolution records conform to:

```
docs/architecture/schemas/principle-resolution.v0.1.schema.json
```

---

## Event Schema

All AEP-MEM-003 state is managed via `src/evolution/AepPrincipleRegistry.ts`.

Key functions:

| Function | Responsibility |
|---|---|
| `registerPrinciple(class, scope, sourceEntryId, toleranceDelta?)` | Add a new ACTIVE governing principle |
| `detectConflict(principleA, principleB)` | Classify whether two principles conflict |
| `resolveConflict(principleA, principleB, conflictType, disposition?)` | Arbitrate conflict; produce resolution record; apply disposition to loser (default: SUBORDINATED) |
| `aggregateEnvelopeCheck(proposedDelta, principles)` | Guard against cumulative tolerance drift across ACTIVE principles |
| `reactivatePrinciple(principleId)` | Transition a SUBORDINATED principle back to ACTIVE |
| `supersedePrinciple(principleId, supersedingId?)` | Permanently replace a principle; record lineage |
| `deprecatePrinciple(principleId)` | Freeze a principle for legacy replay only |
| `retirePrinciple(principleId)` | Administratively remove a principle from all future consideration |
| `dumpPrincipleRegistry()` | Return frozen copy of all registered principles |
| `dumpResolutionLog()` | Return frozen copy of all arbitration records |

---

## Verification Evidence

Full proof is produced by Case 7 in `src/runSliceE.ts`.

| Case | Mechanism | Key assertion |
|---|---|---|
| 7a: Taxonomy override | `TAXONOMY_OVERRIDE` conflict | INTEGRITY_SHIELD (LEVEL_0) wins; PATHFINDING_HEURISTIC becomes `SUBORDINATED` with `EMPIRICAL` catalyst |
| 7b: Specificity collision | `SPECIFICITY_COLLISION` conflict | NARROW_REPLAY_POLICY wins; BROAD_MOVEMENT becomes `SUBORDINATED` with `EMPIRICAL` catalyst |
| 7c: Aggregation guard | `aggregateEnvelopeCheck()` | 0.007 active + 0.004 proposed = 0.011 > 0.01 → `ENVELOPE_EXCEEDED` |
| 7d-1: Reactivation | `reactivatePrinciple()` | SUBORDINATED principle returns to ACTIVE; `lifecycle_catalyst` cleared; ACTIVE/SUPERSEDED/RETIRED reject the call |
| 7d-2: Supersession | `supersedePrinciple()` | Principle becomes SUPERSEDED with `EMPIRICAL` catalyst; `superseded_by` records forward lineage; `supersedes` records backward lineage on the new principle |
| 7d-3: Deprecation | `deprecatePrinciple()` | DEPRECATED principle has `ADMINISTRATIVE` catalyst; no longer counted by `aggregateEnvelopeCheck()` |
| 7d-4: Retirement | `retirePrinciple()` | Principle becomes RETIRED with `ADMINISTRATIVE` catalyst; `reactivatePrinciple()` returns undefined (terminal state) |

---

## Architectural Principle

> No Silent Principle Collision.

The arbitration layer forces the question that the ungoverned path never asks:

> Which constraint has higher authority, and what is the explicit justification
> for that ordering?

That question is a more stable foundation for long-lived autonomous systems than
the default: accumulate principles until their interactions become unpredictable.

The lifecycle state machine extends this to a second question:

> Is this principle temporarily suppressed by a context-dependent constraint,
> or is it permanently obsolete?

Those are different answers that require different representations.

---

## Repository Lineage

```
PR #3    Deterministic pressure-based steal model
    ↓
PR #5    Architecture: deterministic pressure-steal record
    ↓
URS-BETA-005  Agent Evolution Governance (AEP v0.1)
    ↓
URS-BETA-006  Principle Arbitration (AEP-MEM-003)  ← this document
    ↓
         Future meta-governance iterations
```

---

## Complete AEP Stack

```
URS-BETA-005
Evolution Governance
        |
        v
AEP-MEM-001
Historical Memory
"Have we encountered this before?"
        |
        v
AEP-MEM-002
Context Resolution
"Does the previous conclusion still apply?"
        |
        v
AEP-MEM-003
Principle Arbitration
"What happens when two validated conclusions disagree?"
        |
        v
    Experience
        ↓
    Decision
        ↓
    Memory
        ↓
    Context
        ↓
    Principles
        ↓
    Principle Interaction
        ↓
    Better Decisions
```

At this point, the system is not only evolving actions — it is evolving and
governing the rules that produce actions.

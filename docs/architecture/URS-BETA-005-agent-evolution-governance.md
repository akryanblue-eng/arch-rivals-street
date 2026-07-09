# URS-BETA-005: Agent Evolution Governance

## Status

**Accepted implementation record.**

This document is a frozen checkpoint for the Agent Evolution Protocol (AEP) v0.1,
introduced as part of the URS-BETA-005 governance boundary. It is an architectural
record, not a design proposal. Future iterations should treat this document as the
established baseline.

---

## Invariant Chain

URS-BETA-005 closes the three-layer governance boundary established by the BETA series:

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
```

The invariant asserted by URS-BETA-005:

> No component of the system may be modified in response to observed failure without
> passing through the Agent Evolution Protocol.

---

## Problem Statement

### Previous Approach

Without an evolution governance layer, the typical failure response is:

> "The agent failed, therefore retrain the model."

This collapses the diagnosis, component attribution, intervention selection, and
deployment decision into a single implicit step. It produces:

- Over-intervention: base-model retrain when a retrieval fix suffices
- Under-attribution: the wrong component absorbs the change
- Irreversibility: large model changes are expensive to roll back
- Audit blindness: no record of what changed, why, or whether it helped

### The Governance Failure Mode

The missing governance layer creates a direct path from failure observation to
system mutation:

```
Failure observed
      ↓
System mutated
```

This path has no simulation, no rejection vocabulary, and no audit trail.

---

## New Model

### Control Loop

The AEP imposes a complete control loop between failure observation and any
system change:

```
Observe
  ↓
Record (RIG ledger)
  ↓
Diagnose
  ↓
Propose change
  ↓
Simulate
  ↓
Evaluate
  ↓
Deploy / Reject / Block
  ↓
Audit
```

No step may be skipped. A proposed change that fails simulation is Blocked,
not Rejected. A proposed change that passes simulation but does not improve
observed behaviour is Rejected, not Failed.

### Decision Vocabulary

| Outcome | Meaning |
|---|---|
| `PROMOTED` | Change passed simulation and improved observed behaviour; deployed |
| `REJECTED` | Change passed simulation but did not improve observed behaviour; not deployed |
| `BLOCKED` | Change failed simulation; not evaluated; not deployed |

The distinctions are load-bearing:

- `Rejected ≠ Failed`: a rejected change produces evidence that the proposed
  intervention was unnecessary. That evidence is archived.
- `Blocked ≠ Rejected`: a blocked change never reached evaluation. The simulation
  prevented a potentially harmful deployment.

---

## EvolvableComponent Ladder

The AEP enforces a precedence ordering over which component may be modified:

```
RETRIEVAL
    ↓
MEMORY_POLICY
    ↓
TOOL_POLICY
    ↓
PLANNER
    ↓
PROMPT
    ↓
BASE_MODEL
```

A proposed change at level `N` is only eligible if all interventions at levels
`< N` have been simulated and rejected. This prevents the common failure mode
of reaching for the largest available lever (base-model retrain) when a smaller
intervention would have been sufficient.

The ladder encodes the principle:

> What is the smallest justified intervention?

---

## RIG Ledger as Trajectory Layer

The AEP consumes the existing RIG (Replay-Inspectable Governance) ledger as its
source of truth. It does not create a parallel memory system.

### Why This Matters

Without a shared ledger, evolution produces competing histories:

```
CEP audit history
       +
Evolution history
       +
Evaluation history
```

Three independent stores create three independent realities. Reconciliation is
expensive and error-prone.

### AEP Design

```
RIG ledger
    |
    +---> CEP audit
    |
    +---> Evolution governance
    |
    +---> Replay verification
```

One history. Multiple projections. The AEP reads from the ledger to construct
its diagnosis and writes its outcome events back to the same ledger.

---

## Data Flow

```
RIG ledger entry (failure event)
          ↓
AgentEvolutionProtocol.propose()
          ↓
AEP-MEM-001 memory query
          ↓
  ┌──────────────────────┐
  │ NOVEL_INTERVENTION    │  ← proceed to simulation
  │ PRIOR_SUCCESS         │  ← proceed to simulation
  │ PRIOR_FAILURE         │  ← AEP-MEM-002 context check
  │ PRIOR_REJECTION       │  ← AEP-MEM-002 context check
  └──────────────────────┘
         ↓ (AEP-MEM-002 when prior failure/rejection found)
  ┌──────────────────────────────────────┐
  │ Delta == Null (identical context)     │  ← HALTED_BY_MEMORY (halt)
  │ Delta != Null (environmental drift)   │  ← VETO_EVAPORATED (proceed)
  └──────────────────────────────────────┘
         ↓ (if proceeding)
EvolvableComponent ladder check
         ↓
AEP simulation run
         ↓
  ┌───────────────┐
  │ BLOCKED        │  ← simulation failed
  │ REJECTED       │  ← simulation passed, no improvement
  │ PROMOTED       │  ← simulation passed, improvement confirmed
  └───────────────┘
         ↓
evolutionReplayAudit.record()
         ↓
RIG ledger (AEP outcome event)
         ↓
AepDecisionLedger.appendEntry()
         ↓
Decision ledger (causal record; resolution_context if overriding a prior veto)
```

---

## Event Schema

All AEP events are recorded against the schema in:

```
docs/architecture/schemas/aep-events.v0.1.schema.json
```

Key event types:

| Event type | Emitted when |
|---|---|
| `aep.proposal.created` | A change is proposed |
| `aep.simulation.started` | Simulation begins |
| `aep.simulation.blocked` | Simulation detects harmful outcome |
| `aep.proposal.rejected` | Simulation passed; no improvement observed |
| `aep.proposal.promoted` | Simulation passed; improvement confirmed; deployed |

---

## Implementation Contract

### `AgentEvolutionProtocol`

| Method | Responsibility |
|---|---|
| `propose(component, change)` | Validate ladder precedence; initiate simulation |
| `simulate(proposal)` | Run counterfactual against RIG replay |
| `evaluate(simulationResult)` | Compare against baseline; emit PROMOTED / REJECTED |
| `block(proposal, reason)` | Emit BLOCKED; archive reason; halt deployment |

### `evolutionReplayAudit`

| Method | Responsibility |
|---|---|
| `record(event)` | Write AEP event to RIG ledger |
| `replayFrom(ledgerSlice)` | Reconstruct trajectory for a given failure window |
| `diff(baseline, candidate)` | Compute behavioural delta between two replay runs |

---

## Verification Evidence

See `docs/implementation/aep-slice-a.md` for the original proof slice results.
Full six-case evidence is produced by `src/runSliceE.ts`.

| Case | Component | Outcome | Meaning |
|---|---|---|---|
| Retrieval fix | `RETRIEVAL` | `PROMOTED` | Smallest justified change improved behaviour |
| Base-model retrain | `BASE_MODEL` | `REJECTED` | Bigger intervention was unnecessary |
| Tool-policy change | `TOOL_POLICY` | `BLOCKED` | Simulation prevented harmful deployment |
| Historical restraint | `TOOL_POLICY` | `HALTED_BY_MEMORY` | AEP-MEM-001 prevented repeat of known failure |
| Novel exploration | `PLANNER` | `PROMOTED` | Memory system allows novel paths through |
| Contradiction resolution | `TOOL_POLICY` | `PROMOTED` (after prior BLOCKED) | AEP-MEM-002 evaporated legacy-simulator veto |

---

## Architectural Principle

> No Direct Failure → Mutation.

The governance layer forces the question that the ungoverned path never asks:

> Which component caused the failure, and what is the smallest justified intervention?

That question is a much more stable foundation for autonomous system evolution
than the default: observe failure, mutate largest available lever.

---

## Repository Lineage

```
PR #3    Deterministic pressure-based steal model
    ↓
PR #5    Architecture: deterministic pressure-steal record
    ↓
URS-BETA-005  Agent Evolution Governance (AEP v0.1)  ← this document
    ↓
         Future evolution governance iterations
```

All commits listed are reachable from this repository. No external lineage is claimed.

---

## AEP Decision Ledger (Evolutionary Memory Layer)

### Purpose

The AEP Decision Ledger is the durable evolutionary memory layer for the governance
system. Without it, a self-improving system risks cyclic optimization traps: repeating
historical regressions or re-proposing previously rejected architectural interventions.

The ledger transforms isolated governance verdicts into a searchable, chronological
repository of structural causality. It answers:

> What structural changes have already been attempted, under what conditions, and what happened?

### Schema

All ledger entries conform to the schema in:

```
docs/architecture/schemas/aep-decision-ledger.v0.1.schema.json
```

Each entry captures the complete governance trace:

| Field | Content |
|---|---|
| `entry_id` | SHA-256 content-addressed identifier (deterministic, deduplication-safe) |
| `target_subsystem` | EvolvableComponent ladder position |
| `proposal` | Observed failure, proposed intervention, justification level |
| `governance_evaluation` | Verdict (PROMOTED/REJECTED/BLOCKED), reason code, simulation metrics |
| `audit_trail` | Simulation verified flag, tamper detection flag, execution hash |
| `causal_signature` | Optional: failure class, affected metric, origin event hash |
| `context_metadata` | Optional: evaluation environment key-value pairs (simulator version, etc.) |
| `resolution_context` | Optional: AEP-MEM-002 contradiction resolution chain (overruled entry, context delta, resolution type) |

### Justification Levels

The ledger maps each EvolvableComponent to an intervention ladder classification:

| Level | Components | Meaning |
|---|---|---|
| `L1_CONFIG` | RETRIEVAL, MEMORY_POLICY | Configuration-level change |
| `L2_POLICY` | TOOL_POLICY | Policy-level change |
| `L3_ARCHITECTURE` | PLANNER, PROMPT | Architectural change |
| `L4_CORE_MODEL` | BASE_MODEL | Core model change |

### AEP-MEM-001: Memory Query Contract

Before attempting an intervention, the evolution loop queries the decision ledger:

```
queryPriorIntervention({
    target_subsystem: "TOOL_POLICY",
    proposal_class: "write APIs"
})
```

Returns:

```json
{
  "historical_match": true,
  "previous_verdict": "BLOCKED",
  "previous_metrics": { "baseline": "0.600000", "result": "0.800000" },
  "recommended_action": "DO_NOT_RETRY_WITHOUT_NEW_EVIDENCE",
  "result": "PRIOR_FAILURE"
}
```

Optimization constraint: if `result` is `PRIOR_FAILURE` or `PRIOR_REJECTION`,
the evolution loop should not retry the intervention without new evidence. This
prevents the system from repeating known failures.

Novel interventions (no historical match) return `PROCEED_TO_SIMULATION`.

### AEP-MEM-002: Contradiction Resolution

AEP-MEM-002 activates when AEP-MEM-001 returns a prior failure. Rather than
treating the historical veto as absolute, the system evaluates whether the
current evaluation context has changed enough to warrant a re-evaluation.

The control flow:

```
Prior decision found
       │
       ▼
Compare current_context vs entry.context_metadata
       │
┌──────┴────────────────────────────┐
│                                   │
▼                                   ▼
Delta == Null                 Delta != Null
(identical context)           (environmental drift)
       │                             │
       ▼                             ▼
HALTED_BY_MEMORY              VETO_EVAPORATED
                              (proceed to simulation)
```

If context has not changed (`Delta == Null`), `HALTED_BY_MEMORY` is returned
and no simulation is run. This prevents repeated evaluation of the same
intervention under the same conditions.

If context has changed (`Delta != Null`), the veto is evaporated and the
system proceeds to ladder check and simulation. The resolution type is
classified from the delta:

| Resolution type | When applied |
|---|---|
| `SIMULATOR_INVALIDATION` | Simulator version or interpolation mode changed |
| `CONTEXTUAL_BIFURCATION` | Intervention targets a different domain |
| `BOUNDARY_SHIFT` | Environmental threshold or dependency changed |

The overriding PROMOTED entry carries a `resolution_context` that links back
to the historical entry via `overruled_entry_id`. The historical entry is
**not modified** — both decisions coexist as an immutable causal chain.

Key invariant:

> A self-correcting governance system can change its mind when conditions
> change, while preserving a verifiable explanation of why the old judgment
> was valid at the time.

API:

```typescript
evaluateContextDelta({
    target_subsystem: "TOOL_POLICY",
    proposal_class: "micro-checks",
    current_context: {
        simulator_version: "v2.0.0-high-fidelity",
        interpolation_mode: "HERMITE_SPLINE"
    }
})
```

Returns:

```json
{
  "outcome": "VETO_EVAPORATED",
  "overruled_entry_id": "sha256:...",
  "resolution_type": "SIMULATOR_INVALIDATION",
  "context_delta": {
    "simulator_version": { "old": "v1.0.2-legacy", "new": "v2.0.0-high-fidelity" },
    "interpolation_mode": { "old": "LINEAR", "new": "HERMITE_SPLINE" }
  }
}
```

### Ladder Semantics (Updated)

The escalation ladder is scoped per failure context (ledgerRef) and uses a
"first attempt" rule:

- **First proposal for a failure context**: allowed to proceed directly to
  simulation, regardless of ladder level. This enables proposing a TOOL_POLICY
  fix for a tool failure without first exhausting RETRIEVAL fixes that are
  irrelevant to the observed failure class.
- **Subsequent proposals for the same failure context**: all lower-level components
  must have been simulated before a higher-level component may be proposed.

This prevents unnecessary escalation within a failure context while still
allowing the first intervention to target the most appropriate level.

### Implementation

See `src/evolution/AepDecisionLedger.ts`.

Key functions:

| Function | Responsibility |
|---|---|
| `appendEntry(decision, observedFailure, causalSignature?, contextMetadata?, resolutionContext?)` | Write a governance decision to the ledger |
| `queryPriorIntervention(request)` | AEP-MEM-001: query prior interventions before re-attempting |
| `evaluateContextDelta(request)` | AEP-MEM-002: compare current context against historical veto; evaporate veto if context changed |
| `dumpDecisionLedger()` | Return frozen copy of all ledger entries |
| `resetDecisionLedger()` | Reset for isolated test runs |

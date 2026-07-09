# AEP Slice A — Evidence Artifact

## Status

**Implementation record — AEP v0.1.**

This document is the evidence artifact for the Agent Evolution Protocol proof
slice, introduced under URS-BETA-005. It records the decision trace for each
governance outcome, the verified simulation scores, the adversarial audit
results, and the structured evidence record produced by the slice.

---

## Decision Trace

Every governance decision in the proof slice follows this path:

```
Input Experience
      ↓
RIG Ledger Evidence
      ↓
Diagnosis
      ↓
AEP-MEM-001 Memory Query
      ↓
Novel / Known check
      ↓
Evolution Proposal (if justified)
      ↓
Simulation Result
      ↓
Governance Decision
      ↓
Audit Record
      ↓
Append causal record to Decision Ledger
```

No step may be skipped. A proposal that bypasses any step is intercepted
by the audit layer and recorded as a tampered-deploy attempt.

---

## Proof Slice Results

Scores are error / failure rates. **Lower is better.**

| Case | Component | Memory query | Simulation | Error rate | Outcome | Why |
|---|---|---|---|---|---|---|
| 1 | `RETRIEVAL` | — (first proposal) | IMPROVED | 0.60 → 0.00 | ✅ `PROMOTED` | Smallest justified change eliminated observed failure |
| 2 | `BASE_MODEL` | — (ladder check fires first) | Not run | — | ❌ `REJECTED` (`MODEL_CHANGE_NOT_JUSTIFIED`) | Ladder constraint: lower-level fix not yet exhausted |
| 3 | `TOOL_POLICY` | — (first proposal for this context) | REGRESSED | 0.60 → 0.80 | ⛔ `BLOCKED` | Simulation prevented harmful deployment |
| 4 | `TOOL_POLICY` | `PRIOR_FAILURE` → `DO_NOT_RETRY` | Not run | — | 🚫 `HALTED_BY_MEMORY` | AEP-MEM-001 memory gate blocked re-attempt |
| 5 | `PLANNER` | `NOVEL_INTERVENTION` → `PROCEED` | IMPROVED | 0.45 → 0.10 | ✅ `PROMOTED` | Novel path cleared by memory gate; simulation confirmed improvement |

### Why the distinctions matter

**PROMOTED is evidence-backed**

The system did not say `proposal exists → deploy`. It demonstrated:

```
failure → diagnosis → targeted component change → simulated improvement → promotion
```

The promotion decision is traceable to a measured reduction in error rate on
the RIG replay window.

**REJECTED is a valid governance state**

```
REJECTED  =  proposal evaluated and intentionally declined
FAILED    =  system malfunction
```

Case 2 is REJECTED because the governance layer determined that BASE_MODEL
retrain was not justified — the failure had already been addressed at the
RETRIEVAL level (Case 1). No simulation was needed; the ladder evidence was
absent.

**BLOCKED demonstrates the safety boundary**

```
BLOCKED   ≠   REJECTED
```

Case 3 reached simulation. The simulation detected a regression (0.60 → 0.80).
The proposal never reached the improvement evaluation. The evolution layer
acted as a gate, not an optimizer blindly chasing change.

**HALTED_BY_MEMORY prevents optimization loops**

Case 4 never reached simulation. The AEP-MEM-001 memory query returned
`PRIOR_FAILURE` from Case 3's BLOCKED record and recommended
`DO_NOT_RETRY_WITHOUT_NEW_EVIDENCE`. The evolution loop respected this
and halted the proposal before any compute was spent.

This prevents the common failure mode of slightly renaming a known-harmful
proposal and re-attempting it indefinitely.

**NOVEL_INTERVENTION enables discovery**

Case 5 had no prior ledger history. The AEP-MEM-001 query returned
`NOVEL_INTERVENTION` → `PROCEED_TO_SIMULATION`. The proposal proceeded through
the full governance flow and was PROMOTED. The result is now recorded in the
ledger; any future re-attempt of the same class will find this history.

---

## Adversarial Audit

| Check | Method | Result |
|---|---|---|
| Direct deploy without AEP simulation | `attemptDirectDeploy("prop-adversarial-001")` | `DETECTED` |
| Simulation gate enforcement | `recordSimulationEnforced` + Case 3 BLOCKED | `ENFORCED` |

The tampered-deploy check verifies that an actor cannot bypass the protocol
by calling deploy logic directly. The audit layer intercepts the attempt,
records `aep.audit.tampered_deploy_attempt` to the ledger, and returns
`DETECTED`. No deployment occurs.

---

## JSON Evidence Record

The following record is emitted at the end of `runSliceE.ts` and represents
the verified Slice E outcomes:

```json
{
  "slice": "E",
  "feature": "Agent Evolution Governance Protocol",
  "outcomes": [
    {
      "case": "retrieval_fix",
      "decision": "PROMOTED",
      "simulation": "IMPROVED",
      "before": 0.60,
      "after": 0.00
    },
    {
      "case": "base_model_retrain",
      "decision": "REJECTED",
      "reason": "MODEL_CHANGE_NOT_JUSTIFIED"
    },
    {
      "case": "tool_policy_change",
      "decision": "BLOCKED",
      "simulation": "REGRESSED",
      "before": 0.60,
      "after": 0.80
    },
    {
      "case": "tool_policy_reattempt_halted",
      "decision": "HALTED_BY_MEMORY",
      "reason": "DO_NOT_RETRY_WITHOUT_NEW_EVIDENCE"
    },
    {
      "case": "planner_novel_exploration",
      "decision": "PROMOTED",
      "simulation": "IMPROVED",
      "before": 0.45,
      "after": 0.10
    }
  ],
  "audit": {
    "tampered_ledger_deploy_attempt": "DETECTED",
    "simulation_requirement": "ENFORCED"
  }
}
```

---

## Slice Files

| File | Role |
|---|---|
| `src/evolution/AgentEvolutionProtocol.ts` | Ladder validation, `SimulationLabel`, `RejectionReason`, outcome classification |
| `src/evolution/evolutionReplayAudit.ts` | RIG ledger writes, tampered-deploy detection, evidence record builder |
| `src/runSliceE.ts` | Full decision trace, adversarial audit checks, JSON evidence record output |

---

## RIG Ledger Projections

The proof slice emits the following event sequence to the in-process ledger:

```
aep.proposal.created              prop-001  RETRIEVAL     (Case 1)
aep.proposal.promoted             prop-001  RETRIEVAL     (Case 1 — IMPROVED 0.60→0.00)

aep.proposal.created              prop-020  BASE_MODEL    (Case 2)
aep.proposal.rejected             prop-020  BASE_MODEL    (Case 2 — MODEL_CHANGE_NOT_JUSTIFIED)

aep.proposal.created              prop-030  TOOL_POLICY   (Case 3)
aep.simulation.blocked            prop-030  TOOL_POLICY   (Case 3 — REGRESSED 0.60→0.80)
aep.audit.simulation_enforced     prop-030  GOVERNANCE

                                            (Case 4 — memory gate: no events emitted)

aep.proposal.created              prop-050  PLANNER       (Case 5)
aep.proposal.promoted             prop-050  PLANNER       (Case 5 — IMPROVED 0.45→0.10)

aep.audit.tampered_deploy_attempt prop-adversarial-001  (adversarial check)
```

One history. Multiple projections. All events reference the originating RIG
failure ledger entry. Case 4 (historical restraint) produces no RIG ledger
events because the memory gate halts the proposal before any simulation is
attempted.

---

## Verification

| Check | Method | Result |
|---|---|---|
| Syntax | `node -c game.js` | Pass |
| Structural cross-references | Node module check | Pass |
| Case 1 PROMOTED + IMPROVED | `runSliceE` assertion | Pass |
| Case 2 REJECTED (MODEL_CHANGE_NOT_JUSTIFIED, no simulation) | `runSliceE` assertion | Pass |
| Case 3 BLOCKED + REGRESSED | `runSliceE` assertion | Pass |
| Case 4 memory query PRIOR_FAILURE + DO_NOT_RETRY_WITHOUT_NEW_EVIDENCE | `runSliceE` assertion | Pass |
| Case 5 memory query NOVEL_INTERVENTION + PROCEED_TO_SIMULATION | `runSliceE` assertion | Pass |
| Case 5 PROMOTED + IMPROVED after novel gate | `runSliceE` assertion | Pass |
| Tampered deploy DETECTED | `runSliceE` assertion | Pass |
| Simulation requirement ENFORCED | `runSliceE` assertion | Pass |

---

## Commits

Initial AEP files: `4b19d4d`

Evidence artifact upgrade (this document): see current HEAD.

---

## Architectural Principle (restated from URS-BETA-005)

> No Direct Failure → Mutation.

The proof slice demonstrates that this governance boundary is operational:

> The system can modify behaviour proposals without allowing the modification
> process itself to become an unchecked source of authority.

That is the governance primitive required before any serious self-evolving
agent loop.


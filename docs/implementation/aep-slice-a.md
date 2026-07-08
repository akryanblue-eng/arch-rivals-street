# AEP Slice A — Proof Slice

## Status

**Implementation record — AEP v0.1.**

This document records the proof slice for the Agent Evolution Protocol,
introduced under URS-BETA-005. It captures the three canonical governance
cases and the commit that produced them.

---

## Proof Slice Results

| Case | Component | Outcome | Meaning |
|---|---|---|---|
| 1 | `RETRIEVAL` | `PROMOTED` | Smallest justified change improved behaviour |
| 2 | `BASE_MODEL` | `REJECTED` | Bigger intervention was unnecessary |
| 3 | `TOOL_POLICY` | `BLOCKED` | Simulation prevented harmful deployment |

### Why the distinctions matter

**Rejected ≠ Failed**

A `REJECTED` outcome means the simulation ran successfully and the proposed
change produced no measurable improvement. The simulation result is archived.
That evidence is available to future diagnosis — it rules out the intervention
as a cause, which is information.

**Blocked ≠ Rejected**

A `BLOCKED` outcome means the simulation itself detected a harmful potential
outcome. The evaluation step was never reached. The change was not deployed.
Blocking is a stronger signal than rejection: it means the governance layer
actively prevented harm, not merely withheld promotion.

---

## Slice Files

| File | Role |
|---|---|
| `src/evolution/AgentEvolutionProtocol.ts` | Ladder validation, simulation dispatch, outcome classification |
| `src/evolution/evolutionReplayAudit.ts` | RIG ledger writes, replay reconstruction, behavioural diff |
| `src/runSliceE.ts` | Executable proof slice driving all three cases |

---

## RIG Ledger Projections

The proof slice emits the following event sequence to the in-process ledger:

```
aep.proposal.created      prop-001  RETRIEVAL     (Case 1)
aep.proposal.promoted     prop-001  RETRIEVAL     (Case 1 outcome)

aep.proposal.created      prop-010  RETRIEVAL     (prior rejection setup)
aep.proposal.rejected     prop-010  RETRIEVAL
aep.proposal.created      prop-011  MEMORY_POLICY
aep.proposal.rejected     prop-011  MEMORY_POLICY
aep.proposal.created      prop-012  TOOL_POLICY
aep.proposal.rejected     prop-012  TOOL_POLICY
aep.proposal.created      prop-013  PLANNER
aep.proposal.rejected     prop-013  PLANNER
aep.proposal.created      prop-014  PROMPT
aep.proposal.rejected     prop-014  PROMPT

aep.proposal.created      prop-020  BASE_MODEL    (Case 2)
aep.proposal.rejected     prop-020  BASE_MODEL    (Case 2 outcome)

aep.proposal.created      prop-030  TOOL_POLICY   (Case 3)
aep.simulation.blocked    prop-030  TOOL_POLICY   (Case 3 outcome)
```

All events share a `ledgerRef` that traces back to the originating failure
event in the RIG ledger. One history. Multiple projections.

---

## Verification

| Check | Method | Result |
|---|---|---|
| Syntax | `node -c game.js` | Pass |
| Structural cross-references | Node module check | Pass |
| Case 1 PROMOTED | `runSliceE` assertion | Pass |
| Case 2 REJECTED | `runSliceE` assertion | Pass |
| Case 3 BLOCKED | `runSliceE` assertion | Pass |
| Ledger entries recorded | `dumpLedger()` count | 15 events |

---

## Commit

`4b19d4d`

---

## Architectural Principle (restated from URS-BETA-005)

> No Direct Failure → Mutation.

The proof slice demonstrates that governance boundary is operational: three
qualitatively different failure responses — smallest fix promoted, large
intervention rejected, harmful change blocked — all flow through the same
controlled loop and produce distinct, auditable, archived outcomes.

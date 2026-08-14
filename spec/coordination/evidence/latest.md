# TLC evidence — Issue #43

Generated UTC: 2026-08-14T15:20:45.9125975Z

| Config | Expected | Observed | Generated | Distinct | Diameter | Seed | Deadlock |
|---|---:|---:|---:|---:|---:|---:|---:|
| CurrentStaleLeader.cfg | counterexample | counterexample | 9110 | 2138 | 10 | 4301 | False |
| CurrentRollback.cfg | counterexample | counterexample | 56163 | 13210 | 13 | 4302 | False |
| HardenedSafety2.cfg | pass | pass | 4769005 | 622512 | 37 | 4303 | True |
| HardenedSafety3.cfg | pass | pass | 5345193 | 526544 | 31 | 4304 | True |
| LeaseBoundaryZero.cfg | pass | pass | 1433 | 256 | 9 | 4305 | True |
| FailureRecovery.cfg | pass | pass | 1522449 | 192464 | 33 | 4306 | True |
| Liveness.cfg | pass | pass | 15833 | 2304 | 20 | 4307 | True |

Suite expectation result: **True**. Vacuous required actions: **none**.

PASS configs were completely breadth-first explored within their finite bounds. Expected-counterexample configs stop at the first witness. Unexplored scope is recorded in `latest.json` and `AdversarialAudit.md`.

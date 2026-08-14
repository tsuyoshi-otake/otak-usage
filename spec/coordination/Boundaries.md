# Coordination model boundary inventory

This inventory was written before the finite-state model and is normative for
the model. It describes protocol requirements rather than copying TypeScript
control flow. “Current” denotes the unfenced behavior that must yield a
counterexample; “hardened” denotes the required protocol property.

## State boundary

| Boundary / requirement | TLA+ variable | Action(s) | Invariant / property |
|---|---|---|---|
| Actor role is explicit and terminal states are not implicit | `phase[a]` | all actor Actions | `TypeOK`; termination properties |
| Local leader belief may lag durable ownership | `held[a]`, `lock` | `SettleClaim`, `TimeTick`, `WriteClaim` | `NoStale*` in hardened configs |
| Lease ownership has a monotonically assigned generation | `lock.epoch`, `actorEpoch[a]` | `WriteClaim` | `NoSupersededPublish` witness; `NoForbiddenState` |
| Scan result is distinct from persisted cache and published snapshot | `workVersion`, `cache`, `snapshot` | `FinishScan`, `PersistSuccess`, `PublishSuccess` | rollback invariants |
| Followers may lag but never invent a version | `observed[a]` | `ReadSnapshot` | `FollowerReadProgress`, `TypeOK` |
| Retry and failure budgets are observable | `retry[a]`, `failuresLeft` | failure Actions | `TypeOK`, action-coverage vacuity audit |
| External work has bounded capacity and explicit ownership | `externalInFlight` | `StartScan`, terminal/failure Actions | `TypeOK`, `NoStaleExternalEffect` |
| Duplicate commits have stable identity | `publishedKeys` | `PublishSuccess`, `DuplicateInput` | `DuplicateIsIdempotent` |

## Transition and event boundary

| Event/fault | Before → after | Model Action | Required observation |
|---|---|---|---|
| Normal election | follower → claim → settle → leader | `BeginClaim`, `WriteClaim`, `SettleClaim` | one durable holder record |
| Concurrent claim / order reversal | two claimants write/settle in arbitrary interleaving | same Actions | read-back loser becomes follower |
| Renewal | live owner → renewed owner | `RenewLease` | epoch unchanged, TTL restored |
| Missing heartbeat / suspension | live lease → expired lease | `OmitHeartbeat`, `TimeTick` | takeover becomes enabled |
| Normal work | leader → scan → persist → publish | `StartScan`, `FinishScan`, `PersistSuccess`, `PublishSuccess` | version is nondecreasing |
| Duplicated input | scanning → scanning | `DuplicateInput` | no semantic version advance |
| Missing input | scanning → persist existing result | `OmitInput` | no fabricated source version |
| Delayed old work after takeover | old work interleaves with a higher epoch | ordinary Actions | current cfg counterexample; hardened rejection |
| Partial I/O failure and retry | persist/publish → same phase | `RetryableFailure` | bounded retry; no commit |
| Retry exhaustion | persist/publish → follower | `RetryExhausted` | explicit observable terminal owner |
| Cancellation / timeout | active operation → follower | `Cancel`, `Timeout` | in-flight resource released |
| Crash / restart / recovery | any live state → crashed → follower | `Crash`, `Recover` | lock expires or is replaced; no hidden work |
| Graceful lifecycle end | actor → disposed | `Dispose` | resource and owned lock released |
| Explicit handoff | leader → follower | `Release` | owned lock removed only by owner |
| Resource exhaustion | at epoch/version/concurrency maximum → same state | `ResourceExhausted` | no fabricated progress; non-vacuous coverage |

## Time boundary

- `now` is a cyclic diagnostic logical clock bounded by `MaxTime`.
- Lease expiry does **not** compare cyclic timestamps. `lock.ttl` is an
  independent countdown in `0..LeaseTicks`; this preserves the exact boundary
  (`ttl = 0` is expired) without wraparound artifacts.
- `LeaseTicks = 0` is checked separately. It represents immediate expiry, not a
  production recommendation.
- Wall-clock rollback, process suspend duration, timer jitter, and OS clock
  resolution are abstracted to nondeterministic placement of `TimeTick` and
  `OmitHeartbeat`.

## Resource upper bounds

| Resource | Constant | Explored values |
|---|---|---|
| Actors | `Actors` | 2 and 3 |
| Lease duration | `LeaseTicks` | 0 and 1 |
| Logical clock labels | `MaxTime` | 1 and 2 |
| Lease generations | `MaxEpoch` | 1 and 2 |
| Source versions | `MaxVersion` | 1 and 2 |
| Retry count | `MaxRetries` | 0 and 1 |
| Injected failure budget | `FailureBudget` | 0, 1, and 2 |
| Concurrent external operations | `MaxInflight` | 1 |

Bounds are not silently widened into claims about larger systems. The latest
run’s exact constants and hashes are captured in `evidence/latest.json`.

## Lifecycle and external-effect boundary

Every nonterminal phase has at least one explicit success, rejection, failure,
timeout, cancellation, crash, or exhaustion outcome. `Disposed` is terminal;
`Crashed` has the sole recovery transition. File writes, renames, filesystem
walks, provider calls, child processes, and follower reads are each atomic at
this abstraction. Their internal protocols belong to contract/integration
tests, while their ordering and failure outcomes belong here.

## Environment and fairness assumptions

Safety uses no fairness assumption. `FairSpec` uses weak fairness only for
logical time, claim write/read-back, normal scan/persist/publish completion,
stale-commit rejection, and follower reads. It does not assume fairness for
failure injection, crash, cancellation, timeout, or capacity. Liveness allows
an explicit bounded-resource terminal (`MaxEpoch`/`MaxVersion`) because finite
model bounds cannot promise fresh resources forever.

## Config intent

| Config | Intent | Expected result |
|---|---|---|
| `CurrentStaleLeader.cfg` | unfenced superseded leader publish | invariant counterexample |
| `CurrentRollback.cfg` | unfenced cache/snapshot order reversal | invariant counterexample |
| `HardenedSafety2.cfg` | 2 actors, retry/failure, deadlock and safety | PASS |
| `HardenedSafety3.cfg` | 3 actors with tight state bounds | PASS |
| `LeaseBoundaryZero.cfg` | immediate-expiry boundary | PASS |
| `FailureRecovery.cfg` | retry exhaustion, crash/recovery, timeout | PASS |
| `Liveness.cfg` | fairness-qualified progress | PASS |


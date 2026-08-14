# Adversarial verification audit and release decision — Issue #43

## Decision

**GO, with explicitly accepted residual risk.** The model-supported stale
snapshot/cache writer defect is fixed with epoch/token fencing, immutable
per-lease artifacts, exact-fence reads, and lease-scoped cache persistence.
Domain, integration, coordination, mutation, traceability, and finite-state
evidence meet their configured gates. This is not a claim of unbounded proof or
exactly-once behavior for third-party effects.

## Evidence that changed the implementation

- `CurrentStaleLeader.cfg` reaches an epoch-1 publish after epoch 2 owns the
  lock (2,138 distinct states; first witness at depth 10).
- `CurrentRollback.cfg` reaches cache/snapshot rollback (13,210 distinct;
  first witness at depth 13).
- The TypeScript lock now assigns an epoch plus unpredictable lease token.
  Heartbeats, release markers, snapshots, and caches are keyed by that identity;
  a delayed old writer cannot overwrite the successor's artifact.
- Followers read only the snapshot for the lock identity observed before and
  after the read. Cache restore accepts only the current or exactly observed
  predecessor identity. The legacy cache is used once only when no fenced cache
  exists, then removed after the first fenced save.
- Focused coordination tests cover delayed old publish, same-instance old
  release, mismatched fence, cache identity, real extension publication, and
  follower election.

## Mutation findings

The first useful run scored 74.86% and exposed weak month aggregation, today
separation, model ordering, unknown-model state, and default cache-rate checks.
After adding requirement-derived examples, the final score is **90.71%**:
166 killed, 17 survived, 0 no-coverage, and 98 compile-error mutants. Every
survivor is classified as equivalent in
`mutation-classifications.json`; none is a surviving high-risk arithmetic or
boundary mutant. The detailed semantic rationale is generated into
`evidence/mutation-analysis.md`.

## What remains unverified or abstracted

- TLC completely explores only the recorded finite configurations: at most 3
  actors, lease ticks 0/1, 2 epochs, 2 source versions, 1 retry, 2 injected
  failures, and 1 in-flight external operation. Expected-counterexample configs
  intentionally stop at the first witness.
- Atomic TLA+ Actions abstract filesystem rename/durability, Node/VS Code task
  scheduling, byte-level JSON, process suspension, clock jumps, antivirus,
  permissions, disk-full, network shares, and provider internals.
- Provider calls and notifications are non-transactional. Leadership is checked
  after scan and before launching effects, and stale results cannot enter a
  current snapshot/cache, but a request already accepted by a provider can
  complete after takeover. OTLP and RTK contracts are therefore at-least-once,
  not exactly-once; the boundary inventory makes the lack of adapter dedupe and
  automatic retry explicit.
- Epoch-specific heartbeat/release/snapshot files are not yet garbage-collected.
  Claims occur only at activation/failover/manual takeover, so current impact is
  low, but long-lived profiles can accumulate small artifacts.
- One-time legacy-cache migration cannot authenticate which pre-fencing window
  wrote the value. Cache schema validation and a full subsequent scan limit the
  effect; the migration path disappears after the first fenced commit.
- Real OOM, disk exhaustion, TCP half-open behavior, OS crash, and provider
  schema evolution are not deterministically injected. Protocol fixtures cover
  only fields consumed by this extension.
- C2 is a scoped manual atomic-condition inventory for the domain modules. It
  excludes loop termination, TypeScript helper branches, external adapters, and
  infeasible comparator equality eliminated by the unique model-row invariant.
- PBT covers bounded non-negative integer counts and calendar dates from
  2000–2035. It does not prove IEEE-754 behavior beyond safe operational ranges.
- TLC fingerprints have nonzero collision probability and prove the model, not
  a formal refinement mapping to TypeScript.

## Environment and fairness assumptions

Safety uses no fairness. Liveness assumes weak fairness only for logical time,
claim completion/read-back, successful scan/persist/publish, stale rejection,
and follower reads. It assumes neither fair failures nor infinite resources.
Filesystem atomic rename and exact-fence artifact selection are environmental
assumptions tested on the current Windows host, not universal filesystem laws.

## Why release is allowed

The concrete high-impact defect found by the adversarial model is no longer a
shared-state overwrite path; all applicable deterministic gates pass, C2 is
100%, and mutation score exceeds 90% with no unexplained survivor. Remaining
risks affect artifact cleanup, migration provenance, unbounded environments, or
exactly-once external effects already documented as outside adapter contracts.
They are accepted for this release and should become follow-up work if exact
once telemetry, network-share support, or long-term artifact cleanup becomes a
product requirement.

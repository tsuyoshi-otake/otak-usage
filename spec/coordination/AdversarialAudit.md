# Adversarial re-audit and limits of proof

## Findings from the model

The current-behavior configuration intentionally fails. A claimant can start
work in epoch 1, another claimant can atomically replace the lock with epoch 2,
and the old actor can still publish an epoch-1 snapshot because its local
leader belief has not yet been refreshed. A separate configuration searches
for version rollback. Atomic rename prevents torn files; it does not fence an
old writer or impose cross-file cache/snapshot order.

`FencingEnabled = TRUE` began as a protocol proposal rather than a claim about
the TypeScript implementation. Issue #43 now maps it to epoch/token-specific
lock heartbeats, immutable snapshot artifacts, exact-fence follower reads, and
lease-scoped cache keys. Coordination tests reproduce delayed old-leader writes
and reject their artifacts. This is refinement evidence for snapshot/cache
commits, not a machine-checked refinement proof for Node.js or providers.

## Realistic states and transitions not modelled

- Filesystem rename atomicity, write durability, directory-entry durability,
  antivirus locks, permissions, disk-full behavior, corrupt/torn media, and
  network-share semantics are atomic nondeterministic outcomes here.
- A lock file and snapshot/cache files are separate durable objects. The model
  represents their ordering but not byte-level serialization, JSON schema
  evolution, temp-file collisions, fsync, or directory cleanup races.
- JavaScript microtasks, VS Code timer scheduling, extension-host shutdown,
  multiple processes, actual PID reuse, host identity, and group-key changes
  are abstract actors and arbitrary interleavings.
- Real clock jump, suspend/resume duration, timer coalescing, and timestamp
  precision are abstracted to TTL decrement/omission. The cyclic `now` label is
  not a physical clock.
- Provider pagination, rate limits, `Retry-After`, HTTP streaming, subprocess
  process trees, cancellation APIs, log tail partial lines, and schema changes
  require API contract and failure-injection tests.
- Multiple scan groups are not composed. The model is for one independent
  coordination key.
- Usage values are versions, not token maps. Arithmetic correctness belongs to
  the independent oracle/PBT suite.

## Assumptions and exploration limits

- Safety assumes atomic Actions but no fairness. Liveness adds the weak
  fairness assumptions listed in `Boundaries.md`.
- Complete breadth-first exploration means complete only within each finite
  config. More than 3 actors, TTL > 1, epochs/versions > 2, retries > 1,
  failures > 2, and concurrent external capacity > 1 are unsearched.
- TLC fingerprinting has a reported nonzero collision probability. State
  counts and depth are evidence of the explored graph, not a theorem over
  unbounded constants.
- Action coverage detects a completely unreachable Action in this suite. It
  does not prove every guard subcondition is non-vacuous; atomic-condition C2
  and mutation analysis remain separate evidence.
- Deadlock checking does not make intentional stuttering or resource-bound
  terminal states “live”. Liveness properties explicitly admit the documented
  bounds.
- TLC proves the `.tla` model, not its correspondence to TypeScript, Node.js,
  VS Code, the filesystem, or external providers.

## Residual risk and release decision rule

The model-supported stale-writer risk has been addressed for shared snapshots
and caches by durable epoch/token fencing and immutable per-lease artifacts.
Protocol-compatible tests reproduce the old ordering and reject stale reads;
the external-boundary failure-injection suites pass; and the current-witness
and hardened TLC outcomes match `evidence/latest.json`. The combined release
decision, remaining non-transactional external-effect risk, and mutation
analysis live in `docs/verification/adversarial-audit.md`.

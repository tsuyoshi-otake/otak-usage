# Persistence and external-boundary inventory (Issue #43)

This inventory was written before the boundary tests. It treats each adapter as
a state machine and distinguishes adapter guarantees from scheduler policy. The
test doubles implement the same observable protocol as the production dependency;
they do not reuse parser or business-logic implementations as an oracle.

## Claude OAuth usage adapter

| Item | Inventory |
|---|---|
| State | credentials absent, malformed, valid, expired; request idle/in-flight/aborted/completed; response non-2xx, undecodable, partial, complete |
| Input event | refresh invocation with `claudeDir` and logical `nowMs` |
| Transition | read credentials -> validate token/expiry -> one GET -> decode JSON -> map windows |
| Persistence boundary | `<claudeDir>/.credentials.json`, read-only, whole-file JSON |
| External boundary | `GET https://api.anthropic.com/api/oauth/usage`; bearer and `anthropic-beta: oauth-2025-04-20`; 10 s default deadline |
| Terminal states | limits snapshot or `undefined`; all read, HTTP, decode, abort, and resource errors are unavailable rather than thrown |

Failure coverage: expiry equality, absent/malformed credentials, partial response,
HTTP failure, decoder `RangeError` (resource exhaustion), timeout/abort, and recovery
on a subsequent invocation. Object-key order is irrelevant and covered by returning
the windows in reverse presentation order. Duplicate/retry behavior is verified as
exactly one external request per invocation. Caller cancellation is not applicable:
the public contract has no caller-owned `AbortSignal`; only the adapter deadline can
cancel. Crash/restart is represented by a failed invocation followed by a fresh one;
the adapter owns no durable mutable state.

## Codex rollout adapter

| Item | Inventory |
|---|---|
| State | candidate absent/unreadable/truncated/complete; event omitted/malformed/valid/duplicated; bounded tail before/inside event |
| Input event | refresh invocation with scan metadata or filesystem discovery |
| Transition | order candidates -> open -> read at most 256 KiB tail -> close -> scan newest-to-oldest line -> return first candidate's last valid event |
| Persistence boundary | `<codexHome>/sessions/**/rollout*.jsonl`, read-only append log; supplied `ScannedFile.size` defines the snapshot boundary |
| External boundary | filesystem open/read/close and optional session-tree enumeration |
| Terminal states | first selected snapshot or `undefined`; candidate I/O failure falls through to the next candidate |

Failure coverage: duplicate and omitted events, malformed and crash-truncated tail,
missing file, candidate arrival-order reversal, fallback to an older file, append
after simulated writer restart, file-handle finalization, and the 256 KiB resource
bound. Timeout and caller cancellation are not applicable to the current filesystem
API: no deadline or cancellation token is exposed. Retry is candidate failover, not
re-reading the same file. Disk-full is not applicable because this adapter is
read-only; memory exhaustion beyond the explicit tail cap cannot be injected
portably without destabilizing the test host.

## OTLP/HTTP telemetry adapter

| Item | Inventory |
|---|---|
| State | disabled/empty/ready; request connecting/writing/waiting/timed-out/completed; response 2xx/non-2xx |
| Input event | export invocation with immutable config and snapshot |
| Transition | gate -> build payload -> resolve `/v1/metrics` -> one POST -> drain response -> resolve/reject |
| Persistence boundary | none; payload exists only in memory |
| External boundary | OTLP/HTTP JSON POST; content type and byte content length; caller headers; 10 s default deadline |
| Terminal states | `false` for gated omission, `true` for 2xx, rejected promise for transport/timeout/non-2xx |

Failure coverage: exact URL/header/body contract against a loopback HTTP server,
disabled/empty omission, 503 partial failure followed by caller-driven recovery,
duplicate concurrent calls, reversed response completion order, and deterministic
timeout cancellation. The adapter deliberately performs no retry or deduplication;
those are caller policy. External cancellation is not applicable because no
caller-owned signal is exposed. Process crash/restart and durable recovery are not
applicable because this adapter has no process or persisted state. Payload-size
resource exhaustion remains unbounded by this adapter and is listed as residual risk.

## RTK CLI adapter

| Item | Inventory |
|---|---|
| State | process not started/running/exited/timed-out/killed; stdout empty/malformed/complete/over maxBuffer |
| Input event | refresh invocation with executable path and local day key |
| Transition | normalize executable -> spawn once -> collect bounded stdout -> parse summary/daily events -> aggregate periods |
| Persistence boundary | RTK owns its telemetry database; this adapter only consumes the CLI's JSON protocol |
| External boundary | `rtk gain --daily --format json`; hidden window; 15 s default timeout; 64 MiB stdout cap |
| Terminal states | parsed stats or `undefined` for spawn error, nonzero exit, timeout, overflow, or invalid JSON |

Failure coverage: exact executable/arguments/options, missing path default, omitted
daily array, duplicated and reordered daily rows, malformed JSON, nonzero/crash,
timeout kill, maxBuffer exhaustion, no hidden retry, and recovery on a subsequent
process. Caller cancellation is not applicable because the contract exposes only a
timeout. Partial stdout on process error is intentionally discarded. The injected
`execFile` dependency matches Node's process protocol; it does not emulate RTK's
private database, whose schema is outside this repository's contract.

## Traceability to executable evidence

| Requirement / boundary | Evidence |
|---|---|
| Claude file + HTTP contract, failure, deadline, recovery | `src/test/integration/claudeLimits.integration.test.ts` |
| Codex append-log selection, tail bound, failure, restart | `src/test/integration/codexLimits.integration.test.ts` |
| OTLP URL/headers/body, gates, concurrency, timeout, recovery | `src/test/integration/telemetry.integration.test.ts` |
| RTK process invocation, event semantics, timeout/overflow/crash/recovery | `src/test/integration/rtk.integration.test.ts` |

## Explicit residual gaps

- Tests do not prove provider behavior, remote availability, OS scheduling, or
  filesystem atomicity; they prove this repository's side of each protocol.
- There is no internal automatic retry. Recovery evidence therefore invokes the
  adapter again, matching the extension refresh loop's ownership boundary.
- Claude and telemetry have deadlines but no caller cancellation. Codex filesystem
  reads have neither. RTK delegates cancellation to `execFile` timeout.
- OTLP payload construction has no configured maximum body size. Codex and RTK are
  bounded at 256 KiB per inspected tail and 64 MiB stdout respectively.
- Actual machine OOM, disk exhaustion, process suspension, TCP half-open duration,
  and OS crash cannot be injected deterministically in the extension-host suite.
- Protocol fixtures cover the fields consumed by the extension, not every field a
  future Claude, Codex, OTLP, or RTK version may emit. Provider conformance must be
  rechecked when their protocols change.

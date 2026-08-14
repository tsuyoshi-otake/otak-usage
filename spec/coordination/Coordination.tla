----------------------------- MODULE Coordination -----------------------------
EXTENDS Naturals, FiniteSets, TLC

(***************************************************************************
Implementation-independent finite model of the scan coordination protocol.

FencingEnabled = FALSE represents the currently deployed write protocol: an
actor may finish work using its local leader belief after its lease expired.
FencingEnabled = TRUE represents the required hardened protocol: every shared
commit is conditional on the current lease epoch.

Logical time is cyclic only to keep the state space finite. Lease expiry is
modelled by the independent countdown lock.ttl, so wraparound cannot renew or
expire a lease by accident. MaxEpoch and MaxVersion are explicit resource
bounds; their exhaustion is deliberately terminal for the relevant action.
***************************************************************************)

CONSTANTS Actors, MaxTime, LeaseTicks, MaxRetries, MaxEpoch, MaxVersion,
          FailureBudget, MaxInflight, FencingEnabled

NoActor == "none"
Phases == {"Follower", "Claiming", "Settling", "LeaderIdle", "Scanning",
           "Persisting", "Publishing", "Crashed", "Disposed"}

ASSUME /\ Actors # {}
       /\ MaxTime \in Nat
       /\ LeaseTicks \in Nat
       /\ MaxRetries \in Nat
       /\ MaxEpoch \in Nat \ {0}
       /\ MaxVersion \in Nat \ {0}
       /\ FailureBudget \in Nat
       /\ MaxInflight \in Nat \ {0}
       /\ FencingEnabled \in BOOLEAN

VARIABLES now, phase, held, lock, actorEpoch, retry, sourceVersion,
          workVersion, cache, snapshot, observed, externalInFlight,
          failuresLeft, publishedKeys, stalePublish, stalePersist,
          staleExternalEffect, monotonicViolation, cacheMonotonicViolation,
          duplicateSemanticAdvance, publishedAfterDispose

vars == <<now, phase, held, lock, actorEpoch, retry, sourceVersion,
          workVersion, cache, snapshot, observed, externalInFlight,
          failuresLeft, publishedKeys, stalePublish, stalePersist,
          staleExternalEffect, monotonicViolation, cacheMonotonicViolation,
          duplicateSemanticAdvance, publishedAfterDispose>>

EmptyArtifact == [epoch |-> 0, version |-> 0, leader |-> NoActor]

Init ==
    /\ now = 0
    /\ phase = [a \in Actors |-> "Follower"]
    /\ held = [a \in Actors |-> FALSE]
    /\ lock = [holder |-> NoActor, ttl |-> 0, epoch |-> 0]
    /\ actorEpoch = [a \in Actors |-> 0]
    /\ retry = [a \in Actors |-> 0]
    /\ sourceVersion = 0
    /\ workVersion = [a \in Actors |-> 0]
    /\ cache = EmptyArtifact
    /\ snapshot = EmptyArtifact
    /\ observed = [a \in Actors |-> 0]
    /\ externalInFlight = {}
    /\ failuresLeft = FailureBudget
    /\ publishedKeys = {}
    /\ stalePublish = FALSE
    /\ stalePersist = FALSE
    /\ staleExternalEffect = FALSE
    /\ monotonicViolation = FALSE
    /\ cacheMonotonicViolation = FALSE
    /\ duplicateSemanticAdvance = FALSE
    /\ publishedAfterDispose = FALSE

OwnsCurrentLease(a) ==
    /\ lock.holder = a
    /\ lock.ttl > 0
    /\ actorEpoch[a] = lock.epoch

CommitAllowed(a) == ~FencingEnabled \/ OwnsCurrentLease(a)

BeginClaim(a) ==
    /\ phase[a] = "Follower"
    /\ lock.ttl = 0
    /\ lock.epoch < MaxEpoch
    /\ phase' = [phase EXCEPT ![a] = "Claiming"]
    /\ UNCHANGED <<now, held, lock, actorEpoch, retry, sourceVersion,
                    workVersion, cache, snapshot, observed, externalInFlight,
                    failuresLeft, publishedKeys, stalePublish, stalePersist,
                    staleExternalEffect, monotonicViolation,
                    cacheMonotonicViolation, duplicateSemanticAdvance,
                    publishedAfterDispose>>

(* Several claimants may have observed the same stale lock. Their atomic
   renames can complete in either order; the last record wins. *)
WriteClaim(a) ==
    /\ phase[a] = "Claiming"
    /\ lock.epoch < MaxEpoch
    /\ lock' = [holder |-> a, ttl |-> LeaseTicks,
                 epoch |-> lock.epoch + 1]
    /\ actorEpoch' = [actorEpoch EXCEPT ![a] = lock.epoch + 1]
    /\ phase' = [phase EXCEPT ![a] = "Settling"]
    /\ retry' = [retry EXCEPT ![a] = 0]
    /\ UNCHANGED <<now, held, sourceVersion, workVersion, cache, snapshot,
                    observed, externalInFlight, failuresLeft, publishedKeys,
                    stalePublish, stalePersist, staleExternalEffect,
                    monotonicViolation, cacheMonotonicViolation,
                    duplicateSemanticAdvance, publishedAfterDispose>>

SettleClaim(a) ==
    /\ phase[a] = "Settling"
    /\ IF OwnsCurrentLease(a)
          THEN /\ phase' = [phase EXCEPT ![a] = "LeaderIdle"]
               /\ held' = [held EXCEPT ![a] = TRUE]
          ELSE /\ phase' = [phase EXCEPT ![a] = "Follower"]
               /\ held' = [held EXCEPT ![a] = FALSE]
    /\ workVersion' = IF OwnsCurrentLease(a)
                         THEN [workVersion EXCEPT ![a] = cache.version]
                         ELSE workVersion
    /\ UNCHANGED <<now, lock, actorEpoch, retry, sourceVersion,
                    cache, snapshot, observed, externalInFlight, failuresLeft,
                    publishedKeys, stalePublish, stalePersist,
                    staleExternalEffect, monotonicViolation,
                    cacheMonotonicViolation, duplicateSemanticAdvance,
                    publishedAfterDispose>>

RenewLease(a) ==
    /\ phase[a] \in {"LeaderIdle", "Scanning", "Persisting", "Publishing"}
    /\ held[a]
    /\ OwnsCurrentLease(a)
    /\ lock' = [lock EXCEPT !.ttl = LeaseTicks]
    /\ UNCHANGED <<now, phase, held, actorEpoch, retry, sourceVersion,
                    workVersion, cache, snapshot, observed, externalInFlight,
                    failuresLeft, publishedKeys, stalePublish, stalePersist,
                    staleExternalEffect, monotonicViolation,
                    cacheMonotonicViolation, duplicateSemanticAdvance,
                    publishedAfterDispose>>

TimeTick ==
    /\ now' = IF now = MaxTime THEN 0 ELSE now + 1
    /\ lock' = IF lock.ttl > 0
                  THEN [lock EXCEPT !.ttl = @ - 1]
                  ELSE lock
    /\ UNCHANGED <<phase, held, actorEpoch, retry, sourceVersion, workVersion,
                    cache, snapshot, observed, externalInFlight, failuresLeft,
                    publishedKeys, stalePublish, stalePersist,
                    staleExternalEffect, monotonicViolation,
                    cacheMonotonicViolation, duplicateSemanticAdvance,
                    publishedAfterDispose>>

(* A heartbeat can be omitted by scheduling, suspension, or I/O failure.  Time
   then advances and the lease countdown still decreases. *)
OmitHeartbeat(a) ==
    /\ phase[a] \in {"LeaderIdle", "Scanning", "Persisting", "Publishing"}
    /\ held[a]
    /\ TimeTick

StartScan(a) ==
    /\ phase[a] = "LeaderIdle"
    /\ held[a]
    /\ Cardinality(externalInFlight) < MaxInflight
    /\ phase' = [phase EXCEPT ![a] = "Scanning"]
    /\ externalInFlight' = externalInFlight \cup {a}
    /\ UNCHANGED <<now, held, lock, actorEpoch, retry, sourceVersion,
                    workVersion, cache, snapshot, observed, failuresLeft,
                    publishedKeys, stalePublish, stalePersist,
                    staleExternalEffect, monotonicViolation,
                    cacheMonotonicViolation, duplicateSemanticAdvance,
                    publishedAfterDispose>>

FinishScan(a) ==
    /\ phase[a] = "Scanning"
    /\ sourceVersion < MaxVersion
    /\ IF CommitAllowed(a)
          THEN /\ sourceVersion' = sourceVersion + 1
               /\ workVersion' = [workVersion EXCEPT ![a] = sourceVersion + 1]
               /\ phase' = [phase EXCEPT ![a] = "Persisting"]
               /\ staleExternalEffect' = (staleExternalEffect \/ ~OwnsCurrentLease(a))
          ELSE /\ sourceVersion' = sourceVersion
               /\ workVersion' = workVersion
               /\ phase' = [phase EXCEPT ![a] = "Follower"]
               /\ staleExternalEffect' = staleExternalEffect
    /\ held' = IF FencingEnabled /\ ~OwnsCurrentLease(a)
                  THEN [held EXCEPT ![a] = FALSE] ELSE held
    /\ externalInFlight' = externalInFlight \ {a}
    /\ UNCHANGED <<now, lock, actorEpoch, retry, cache, snapshot, observed,
                    failuresLeft, publishedKeys, stalePublish, stalePersist,
                    monotonicViolation, cacheMonotonicViolation,
                    duplicateSemanticAdvance, publishedAfterDispose>>

(* A duplicated input/event is consumed idempotently: it does not advance the
   source or work version.  Its self-loop is visible in TLC action coverage. *)
DuplicateInput(a) ==
    /\ phase[a] = "Scanning"
    /\ UNCHANGED vars

(* Makes exhaustion of each finite resource observable in action coverage.
   The transition is deliberately a self-loop: exhaustion must not fabricate
   progress, epochs, input, or external capacity. *)
ResourceExhausted(a) ==
    /\ \/ (phase[a] = "Follower" /\ lock.epoch = MaxEpoch)
       \/ (phase[a] = "Scanning" /\ sourceVersion = MaxVersion)
       \/ (phase[a] = "LeaderIdle" /\
           Cardinality(externalInFlight) = MaxInflight)
    /\ UNCHANGED vars

(* An omitted log/event produces no new version and moves to persistence of the
   already-known work, exactly the boundary that must not invent usage. *)
OmitInput(a) ==
    /\ phase[a] = "Scanning"
    /\ phase' = [phase EXCEPT ![a] = "Persisting"]
    /\ externalInFlight' = externalInFlight \ {a}
    /\ UNCHANGED <<now, held, lock, actorEpoch, retry, sourceVersion,
                    workVersion, cache, snapshot, observed, failuresLeft,
                    publishedKeys, stalePublish, stalePersist,
                    staleExternalEffect, monotonicViolation,
                    cacheMonotonicViolation, duplicateSemanticAdvance,
                    publishedAfterDispose>>

PersistSuccess(a) ==
    /\ phase[a] = "Persisting"
    /\ CommitAllowed(a)
    /\ cache' = [epoch |-> actorEpoch[a], version |-> workVersion[a],
                  leader |-> a]
    /\ stalePersist' = (stalePersist \/ ~OwnsCurrentLease(a))
    /\ cacheMonotonicViolation' = (cacheMonotonicViolation \/
                                    (workVersion[a] < cache.version))
    /\ phase' = [phase EXCEPT ![a] = "Publishing"]
    /\ UNCHANGED <<now, held, lock, actorEpoch, retry, sourceVersion,
                    workVersion, snapshot, observed, externalInFlight,
                    failuresLeft, publishedKeys, stalePublish,
                    staleExternalEffect, monotonicViolation,
                    duplicateSemanticAdvance, publishedAfterDispose>>

PublishSuccess(a) ==
    /\ phase[a] = "Publishing"
    /\ CommitAllowed(a)
    /\ LET key == <<actorEpoch[a], workVersion[a]>> IN
       /\ snapshot' = [epoch |-> actorEpoch[a], version |-> workVersion[a],
                        leader |-> a]
       /\ publishedKeys' = publishedKeys \cup {key}
       /\ duplicateSemanticAdvance' = (duplicateSemanticAdvance \/
             ((key \in publishedKeys) /\ (workVersion[a] # snapshot.version)))
    /\ stalePublish' = (stalePublish \/ ~OwnsCurrentLease(a))
    /\ monotonicViolation' = (monotonicViolation \/
                               (workVersion[a] < snapshot.version))
    /\ publishedAfterDispose' = (publishedAfterDispose \/
                                   (phase[a] = "Disposed"))
    /\ phase' = [phase EXCEPT ![a] = "LeaderIdle"]
    /\ retry' = [retry EXCEPT ![a] = 0]
    /\ UNCHANGED <<now, held, lock, actorEpoch, sourceVersion, workVersion,
                    cache, observed, externalInFlight, failuresLeft,
                    stalePersist, staleExternalEffect,
                    cacheMonotonicViolation>>

RejectStaleCommit(a) ==
    /\ FencingEnabled
    /\ phase[a] \in {"Persisting", "Publishing"}
    /\ ~OwnsCurrentLease(a)
    /\ phase' = [phase EXCEPT ![a] = "Follower"]
    /\ held' = [held EXCEPT ![a] = FALSE]
    /\ retry' = [retry EXCEPT ![a] = 0]
    /\ UNCHANGED <<now, lock, actorEpoch, sourceVersion, workVersion, cache,
                    snapshot, observed, externalInFlight, failuresLeft,
                    publishedKeys, stalePublish, stalePersist,
                    staleExternalEffect, monotonicViolation,
                    cacheMonotonicViolation, duplicateSemanticAdvance,
                    publishedAfterDispose>>

RetryableFailure(a) ==
    /\ phase[a] \in {"Persisting", "Publishing"}
    /\ failuresLeft > 0
    /\ retry[a] < MaxRetries
    /\ failuresLeft' = failuresLeft - 1
    /\ retry' = [retry EXCEPT ![a] = @ + 1]
    /\ UNCHANGED <<now, phase, held, lock, actorEpoch, sourceVersion,
                    workVersion, cache, snapshot, observed, externalInFlight,
                    publishedKeys, stalePublish, stalePersist,
                    staleExternalEffect, monotonicViolation,
                    cacheMonotonicViolation, duplicateSemanticAdvance,
                    publishedAfterDispose>>

RetryExhausted(a) ==
    /\ phase[a] \in {"Persisting", "Publishing"}
    /\ failuresLeft > 0
    /\ retry[a] = MaxRetries
    /\ failuresLeft' = failuresLeft - 1
    /\ phase' = [phase EXCEPT ![a] = "Follower"]
    /\ held' = [held EXCEPT ![a] = FALSE]
    /\ UNCHANGED <<now, lock, actorEpoch, retry, sourceVersion, workVersion,
                    cache, snapshot, observed, externalInFlight,
                    publishedKeys, stalePublish, stalePersist,
                    staleExternalEffect, monotonicViolation,
                    cacheMonotonicViolation, duplicateSemanticAdvance,
                    publishedAfterDispose>>

Timeout(a) ==
    /\ phase[a] \in {"Scanning", "Persisting", "Publishing"}
    /\ phase' = [phase EXCEPT ![a] = "Follower"]
    /\ held' = [held EXCEPT ![a] = FALSE]
    /\ externalInFlight' = externalInFlight \ {a}
    /\ UNCHANGED <<now, lock, actorEpoch, retry, sourceVersion, workVersion,
                    cache, snapshot, observed, failuresLeft, publishedKeys,
                    stalePublish, stalePersist, staleExternalEffect,
                    monotonicViolation, cacheMonotonicViolation,
                    duplicateSemanticAdvance, publishedAfterDispose>>

Cancel(a) ==
    /\ phase[a] \in {"Claiming", "Settling", "Scanning", "Persisting",
                      "Publishing"}
    /\ phase' = [phase EXCEPT ![a] = "Follower"]
    /\ held' = [held EXCEPT ![a] = FALSE]
    /\ externalInFlight' = externalInFlight \ {a}
    /\ UNCHANGED <<now, lock, actorEpoch, retry, sourceVersion, workVersion,
                    cache, snapshot, observed, failuresLeft, publishedKeys,
                    stalePublish, stalePersist, staleExternalEffect,
                    monotonicViolation, cacheMonotonicViolation,
                    duplicateSemanticAdvance, publishedAfterDispose>>

Crash(a) ==
    /\ phase[a] # "Disposed"
    /\ phase[a] # "Crashed"
    /\ phase' = [phase EXCEPT ![a] = "Crashed"]
    /\ held' = [held EXCEPT ![a] = FALSE]
    /\ externalInFlight' = externalInFlight \ {a}
    /\ UNCHANGED <<now, lock, actorEpoch, retry, sourceVersion, workVersion,
                    cache, snapshot, observed, failuresLeft, publishedKeys,
                    stalePublish, stalePersist, staleExternalEffect,
                    monotonicViolation, cacheMonotonicViolation,
                    duplicateSemanticAdvance, publishedAfterDispose>>

Recover(a) ==
    /\ phase[a] = "Crashed"
    /\ phase' = [phase EXCEPT ![a] = "Follower"]
    /\ retry' = [retry EXCEPT ![a] = 0]
    /\ UNCHANGED <<now, held, lock, actorEpoch, sourceVersion, workVersion,
                    cache, snapshot, observed, externalInFlight, failuresLeft,
                    publishedKeys, stalePublish, stalePersist,
                    staleExternalEffect, monotonicViolation,
                    cacheMonotonicViolation, duplicateSemanticAdvance,
                    publishedAfterDispose>>

Dispose(a) ==
    /\ phase[a] # "Disposed"
    /\ phase' = [phase EXCEPT ![a] = "Disposed"]
    /\ held' = [held EXCEPT ![a] = FALSE]
    /\ externalInFlight' = externalInFlight \ {a}
    /\ lock' = IF lock.holder = a
                  THEN [holder |-> NoActor, ttl |-> 0, epoch |-> lock.epoch]
                  ELSE lock
    /\ UNCHANGED <<now, actorEpoch, retry, sourceVersion, workVersion, cache,
                    snapshot, observed, failuresLeft, publishedKeys,
                    stalePublish, stalePersist, staleExternalEffect,
                    monotonicViolation, cacheMonotonicViolation,
                    duplicateSemanticAdvance, publishedAfterDispose>>

Release(a) ==
    /\ phase[a] = "LeaderIdle"
    /\ phase' = [phase EXCEPT ![a] = "Follower"]
    /\ held' = [held EXCEPT ![a] = FALSE]
    /\ lock' = IF lock.holder = a
                  THEN [holder |-> NoActor, ttl |-> 0, epoch |-> lock.epoch]
                  ELSE lock
    /\ UNCHANGED <<now, actorEpoch, retry, sourceVersion, workVersion, cache,
                    snapshot, observed, externalInFlight, failuresLeft,
                    publishedKeys, stalePublish, stalePersist,
                    staleExternalEffect, monotonicViolation,
                    cacheMonotonicViolation, duplicateSemanticAdvance,
                    publishedAfterDispose>>

ReadSnapshot(a) ==
    /\ phase[a] = "Follower"
    /\ snapshot.version > observed[a]
    /\ observed' = [observed EXCEPT ![a] = snapshot.version]
    /\ UNCHANGED <<now, phase, held, lock, actorEpoch, retry, sourceVersion,
                    workVersion, cache, snapshot, externalInFlight,
                    failuresLeft, publishedKeys, stalePublish, stalePersist,
                    staleExternalEffect, monotonicViolation,
                    cacheMonotonicViolation, duplicateSemanticAdvance,
                    publishedAfterDispose>>

Next ==
    \/ TimeTick
    \/ \E a \in Actors:
          BeginClaim(a) \/ WriteClaim(a) \/ SettleClaim(a) \/ RenewLease(a) \/
          OmitHeartbeat(a) \/ StartScan(a) \/ FinishScan(a) \/
          DuplicateInput(a) \/ ResourceExhausted(a) \/ OmitInput(a) \/
          PersistSuccess(a) \/
          PublishSuccess(a) \/ RejectStaleCommit(a) \/ RetryableFailure(a) \/
          RetryExhausted(a) \/ Timeout(a) \/ Cancel(a) \/ Crash(a) \/
          Recover(a) \/ Dispose(a) \/ Release(a) \/ ReadSnapshot(a)

Spec == Init /\ [][Next]_vars

(***************************************************************************
Safety and reachability predicates.
***************************************************************************)

TypeOK ==
    /\ now \in 0..MaxTime
    /\ phase \in [Actors -> Phases]
    /\ held \in [Actors -> BOOLEAN]
    /\ lock.holder \in Actors \cup {NoActor}
    /\ lock.ttl \in 0..LeaseTicks
    /\ lock.epoch \in 0..MaxEpoch
    /\ actorEpoch \in [Actors -> 0..MaxEpoch]
    /\ retry \in [Actors -> 0..MaxRetries]
    /\ sourceVersion \in 0..MaxVersion
    /\ workVersion \in [Actors -> 0..MaxVersion]
    /\ cache.epoch \in 0..MaxEpoch
    /\ cache.version \in 0..MaxVersion
    /\ snapshot.epoch \in 0..MaxEpoch
    /\ snapshot.version \in 0..MaxVersion
    /\ observed \in [Actors -> 0..MaxVersion]
    /\ externalInFlight \subseteq Actors
    /\ Cardinality(externalInFlight) <= MaxInflight
    /\ failuresLeft \in 0..FailureBudget
    /\ publishedKeys \subseteq (0..MaxEpoch) \X (0..MaxVersion)
    /\ stalePublish \in BOOLEAN
    /\ stalePersist \in BOOLEAN
    /\ staleExternalEffect \in BOOLEAN
    /\ monotonicViolation \in BOOLEAN
    /\ cacheMonotonicViolation \in BOOLEAN
    /\ duplicateSemanticAdvance \in BOOLEAN
    /\ publishedAfterDispose \in BOOLEAN

NoStalePublish == ~stalePublish
(* Stronger witness used by the current-behavior counterexample: the snapshot
   came from an epoch that has already been superseded by another claimant. *)
NoSupersededPublish == ~(stalePublish /\ lock.epoch > snapshot.epoch)
NoStalePersist == ~stalePersist
SnapshotNeverRollsBack == ~monotonicViolation
CacheNeverRollsBack == ~cacheMonotonicViolation
DuplicateIsIdempotent == ~duplicateSemanticAdvance
NoPublishAfterDispose == ~publishedAfterDispose
NoStaleExternalEffect == ~staleExternalEffect

ForbiddenState == stalePublish \/ stalePersist \/ monotonicViolation \/
                  cacheMonotonicViolation \/ duplicateSemanticAdvance \/
                  publishedAfterDispose
NoForbiddenState == ~ForbiddenState

(***************************************************************************
Liveness.  FairSpec explicitly assumes scheduler fairness for logical time and
for the non-failing completion/rejection actions. It does not assume fairness
of crash, cancellation, timeout, failure injection, or resource availability.
***************************************************************************)

FairSpec ==
    Spec
    /\ WF_vars(TimeTick)
    /\ \A a \in Actors:
          /\ WF_vars(WriteClaim(a))
          /\ WF_vars(SettleClaim(a))
          /\ WF_vars(FinishScan(a))
          /\ WF_vars(PersistSuccess(a))
          /\ WF_vars(PublishSuccess(a))
          /\ WF_vars(RejectStaleCommit(a))
          /\ WF_vars(ReadSnapshot(a))

ClaimTerminates ==
    \A a \in Actors: (phase[a] \in {"Claiming", "Settling"}) ~>
                       (phase[a] \notin {"Claiming", "Settling"} \/
                        (phase[a] = "Claiming" /\ lock.epoch = MaxEpoch))

ScanTerminates ==
    \A a \in Actors: (phase[a] = "Scanning") ~>
                       (phase[a] # "Scanning" \/ sourceVersion = MaxVersion)

PersistTerminates ==
    \A a \in Actors: (phase[a] = "Persisting") ~> (phase[a] # "Persisting")

PublishTerminates ==
    \A a \in Actors: (phase[a] = "Publishing") ~> (phase[a] # "Publishing")

FollowerReadProgress ==
    \A a \in Actors:
      (phase[a] = "Follower" /\ snapshot.version > observed[a]) ~>
      (phase[a] # "Follower" \/ observed[a] = snapshot.version)

=============================================================================

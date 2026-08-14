# TLC evidence

Run from the repository root:

```powershell
rtk proxy pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/tlc/run-tlc.ps1
```

The runner finds the existing local `tla2tools.jar` (or accepts `-Jar`), uses
fixed seeds, runs one worker for reproducible breadth-first exploration,
captures compact logs/counterexamples plus JSON/Markdown metrics here, and
deletes TLC checkpoint/state databases from a task-specific directory under
`$env:USERPROFILE/tmp` in `finally`. It never downloads or installs tooling.

`Current*.cfg` are expected counterexamples. An expected counterexample is a
suite success only when TLC actually reports the invariant violation. All
hardened and liveness configs must report no error. The suite also fails when a
required Action has zero TLC invocations across all configs (vacuity audit).

`latest.json` is authoritative for exact constants, versions, seeds, hashes,
generated/distinct/remaining states, graph diameter, deadlock settings, Action
coverage, and unexplored scope. `latest.md` is its compact human view.

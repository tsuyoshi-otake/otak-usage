[CmdletBinding()]
param(
    [string[]]$Config,
    [string]$Jar,
    [int]$Workers = 1,
    [switch]$KeepRawOutput
)

$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$specDir = Join-Path $repo 'spec\coordination'
$evidenceDir = Join-Path $specDir 'evidence'
$taskTmpRoot = Join-Path $env:USERPROFILE 'tmp\otak-usage-tlc-issue43'
$runTmp = Join-Path $taskTmpRoot ([Guid]::NewGuid().ToString('N'))

$suite = @(
    [pscustomobject]@{ Config = 'CurrentStaleLeader.cfg'; Seed = 4301; Expected = 'counterexample' },
    [pscustomobject]@{ Config = 'CurrentRollback.cfg'; Seed = 4302; Expected = 'counterexample' },
    [pscustomobject]@{ Config = 'HardenedSafety2.cfg'; Seed = 4303; Expected = 'pass' },
    [pscustomobject]@{ Config = 'HardenedSafety3.cfg'; Seed = 4304; Expected = 'pass' },
    [pscustomobject]@{ Config = 'LeaseBoundaryZero.cfg'; Seed = 4305; Expected = 'pass' },
    [pscustomobject]@{ Config = 'FailureRecovery.cfg'; Seed = 4306; Expected = 'pass' },
    [pscustomobject]@{ Config = 'Liveness.cfg'; Seed = 4307; Expected = 'pass' }
)
$isFullSuite = $Config.Count -eq 0

if ($Config.Count -gt 0) {
    $wanted = [Collections.Generic.HashSet[string]]::new(
        [string[]]($Config | ForEach-Object { if ($_ -like '*.cfg') { $_ } else { "$_.cfg" } }),
        [StringComparer]::OrdinalIgnoreCase)
    $suite = @($suite | Where-Object { $wanted.Contains($_.Config) })
    if ($suite.Count -ne $wanted.Count) {
        throw "Unknown config requested. Known configs: $($suite.Config -join ', ')"
    }
}

if ([string]::IsNullOrWhiteSpace($Jar)) {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\TLAplus\tla2tools.jar'),
        (Join-Path $env:USERPROFILE 'tmp\tla-plus-v1.7.4-official\tla2tools.jar'),
        (Join-Path $env:USERPROFILE 'tmp\tla\tla2tools.jar')
    )
    $Jar = $candidates | Where-Object { [IO.File]::Exists($_) } | Select-Object -First 1
}
if ([string]::IsNullOrWhiteSpace($Jar) -or -not [IO.File]::Exists($Jar)) {
    throw 'tla2tools.jar not found. Pass -Jar <absolute-path>; no download/install is performed.'
}

function Match-Number([string]$Text, [string]$Pattern, [int]$Group = 1) {
    $m = [regex]::Match($Text, $Pattern, [Text.RegularExpressions.RegexOptions]::Multiline)
    if ($m.Success) { return [int64]$m.Groups[$Group].Value }
    return $null
}

function Get-Constants([string]$CfgPath) {
    $result = [ordered]@{}
    foreach ($line in [IO.File]::ReadLines($CfgPath)) {
        $m = [regex]::Match($line, '^\s*([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$')
        if ($m.Success) { $result[$m.Groups[1].Value] = $m.Groups[2].Value }
    }
    return [pscustomobject]$result
}

[IO.Directory]::CreateDirectory($evidenceDir) | Out-Null
[IO.Directory]::CreateDirectory($runTmp) | Out-Null
$results = [Collections.Generic.List[object]]::new()
$suitePassed = $true

try {
    $javaVersion = ((& java -version 2>&1) | ForEach-Object { "$_" }) -join ' | '
    foreach ($case in $suite) {
        $name = [IO.Path]::GetFileNameWithoutExtension($case.Config)
        $cfgPath = Join-Path $specDir $case.Config
        $meta = Join-Path $runTmp $name
        [IO.Directory]::CreateDirectory($meta) | Out-Null
        $arguments = @(
            '-XX:+UseParallelGC', '-cp', $Jar, 'tlc2.TLC',
            '-metadir', $meta, '-config', $case.Config,
            '-workers', "$Workers", '-coverage', '1', '-seed', "$($case.Seed)",
            'Coordination.tla'
        )
        Push-Location $specDir
        try {
            $lines = @(& java @arguments 2>&1 | ForEach-Object { "$_" })
            $exitCode = $LASTEXITCODE
        } finally {
            Pop-Location
        }
        $text = $lines -join [Environment]::NewLine
        $hasPass = $text.Contains('Model checking completed. No error has been found.')
        $hasCounterexample = $text -match 'Invariant .+ is violated|Temporal properties were violated'
        $observedOutcome = if ($hasPass) { 'pass' } elseif ($hasCounterexample) { 'counterexample' } else { 'tool-error' }
        $expectationMet = $observedOutcome -eq $case.Expected
        $suitePassed = $suitePassed -and $expectationMet

        $actions = [ordered]@{}
        foreach ($line in $lines) {
            $m = [regex]::Match($line, '^<([A-Za-z][A-Za-z0-9_]*) line .*?>:\s*([0-9]+):([0-9]+)\s*$')
            if ($m.Success) {
                $actions[$m.Groups[1].Value] = [pscustomobject]@{
                    newStates = [int64]$m.Groups[2].Value
                    invocations = [int64]$m.Groups[3].Value
                }
            }
        }

        $summaryLines = @($lines | Where-Object {
            $_ -match '^TLC2 Version|^Running breadth-first|^Model checking completed|^Error: Invariant|^Error: Temporal|states generated,|depth of the complete|Finished in '
        })
        [IO.File]::WriteAllLines((Join-Path $evidenceDir "$name.log"), $summaryLines)
        if ($KeepRawOutput) {
            [IO.File]::WriteAllLines((Join-Path $evidenceDir "$name.raw.log"), $lines)
        }
        if ($observedOutcome -eq 'counterexample') {
            $start = [Array]::FindIndex($lines, [Predicate[string]]{ param($s) $s -match '^Error: The behavior up to this point|^Error: The following behavior' })
            if ($start -ge 0) {
                $relativeEnd = [Array]::FindIndex(
                    $lines[($start + 1)..($lines.Count - 1)],
                    [Predicate[string]]{ param($s) $s -match '^The coverage statistics|^[0-9]+ states generated,' })
                $end = if ($relativeEnd -ge 0) {
                    $start + $relativeEnd
                } else {
                    [Math]::Min($lines.Count - 1, $start + 260)
                }
                [IO.File]::WriteAllLines((Join-Path $evidenceDir "$name.counterexample.txt"), $lines[$start..$end])
            }
        }

        $tlcVersion = ([regex]::Match($text, 'TLC2 Version ([^\r\n]+)')).Groups[1].Value
        $result = [pscustomobject]@{
            config = $case.Config
            expectedOutcome = $case.Expected
            observedOutcome = $observedOutcome
            expectationMet = $expectationMet
            exitCode = $exitCode
            exploration = if ($observedOutcome -eq 'pass') {
                'complete breadth-first explicit-state within finite config'
            } else {
                'breadth-first explicit-state until expected counterexample (remaining graph intentionally unexplored)'
            }
            tlcVersion = $tlcVersion
            javaVersion = $javaVersion
            seed = $case.Seed
            workers = $Workers
            constants = Get-Constants $cfgPath
            generatedStates = Match-Number $text '(?m)^([0-9]+) states generated,'
            distinctStates = Match-Number $text '(?m)^[0-9]+ states generated, ([0-9]+) distinct states found' 1
            remainingStates = Match-Number $text '(?m)^[0-9]+ states generated, [0-9]+ distinct states found, ([0-9]+) states left on queue' 1
            diameter = Match-Number $text 'depth of the complete state graph search is ([0-9]+)'
            diameterMeaning = if ($observedOutcome -eq 'pass') {
                'TLC complete-state-graph search depth'
            } else {
                'TLC search depth at first counterexample; not full graph diameter'
            }
            deadlockChecked = ([IO.File]::ReadAllText($cfgPath) -match 'CHECK_DEADLOCK\s+TRUE')
            actionCoverage = [pscustomobject]$actions
            specSha256 = (Get-FileHash (Join-Path $specDir 'Coordination.tla') -Algorithm SHA256).Hash.ToLowerInvariant()
            configSha256 = (Get-FileHash $cfgPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        $results.Add($result)
        Write-Host ("{0}: expected={1}, observed={2}, distinct={3}, depth={4}" -f $name, $case.Expected, $observedOutcome, $result.distinctStates, $result.diameter)
    }

    $requiredActions = @(
        'BeginClaim', 'WriteClaim', 'SettleClaim', 'RenewLease', 'TimeTick',
        'OmitHeartbeat', 'StartScan', 'FinishScan', 'DuplicateInput',
        'ResourceExhausted', 'OmitInput', 'PersistSuccess', 'PublishSuccess',
        'RejectStaleCommit', 'RetryableFailure', 'RetryExhausted', 'Timeout',
        'Cancel', 'Crash', 'Recover', 'Dispose', 'Release', 'ReadSnapshot'
    )
    $vacuous = @($requiredActions | Where-Object {
        $action = $_
        -not ($results | Where-Object { $_.actionCoverage.$action.invocations -gt 0 })
    })
    if ($isFullSuite -and $vacuous.Count -gt 0) { $suitePassed = $false }

    $report = [pscustomobject]@{
        issue = 43
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        suitePassed = $suitePassed
        fullSuite = $isFullSuite
        vacuityAudit = [pscustomobject]@{
            method = 'TLC action coverage; every required Action must have at least one invocation in the suite'
            requiredActions = $requiredActions
            actionsWithZeroInvocations = $vacuous
        }
        unexploredScope = @(
            'More than 3 actors',
            'LeaseTicks greater than 1 and non-cyclic real wall-clock histories',
            'More than 2 lease epochs, 2 source versions, 1 retry, 2 injected failures, or 1 concurrent external operation',
            'Filesystem and scheduler implementation semantics below the atomic-action abstraction',
            'Probabilistic collision absence (TLC fingerprints are not a mathematical proof of collision freedom)'
        )
        runs = $results
    }
    $json = $report | ConvertTo-Json -Depth 12
    [IO.File]::WriteAllText((Join-Path $evidenceDir 'latest.json'), $json + [Environment]::NewLine)

    $md = [Collections.Generic.List[string]]::new()
    $md.Add('# TLC evidence — Issue #43')
    $md.Add('')
    $md.Add("Generated UTC: $($report.generatedAtUtc)")
    $md.Add('')
    $md.Add('| Config | Expected | Observed | Generated | Distinct | Diameter | Seed | Deadlock |')
    $md.Add('|---|---:|---:|---:|---:|---:|---:|---:|')
    foreach ($run in $results) {
        $md.Add("| $($run.config) | $($run.expectedOutcome) | $($run.observedOutcome) | $($run.generatedStates) | $($run.distinctStates) | $($run.diameter) | $($run.seed) | $($run.deadlockChecked) |")
    }
    $md.Add('')
    $vacuousSummary = if ($vacuous.Count -eq 0) { 'none' } else { $vacuous -join ', ' }
    $md.Add("Suite expectation result: **$suitePassed**. Vacuous required actions: **$vacuousSummary**.")
    $md.Add('')
    $md.Add('PASS configs were completely breadth-first explored within their finite bounds. Expected-counterexample configs stop at the first witness. Unexplored scope is recorded in `latest.json` and `AdversarialAudit.md`.')
    [IO.File]::WriteAllLines((Join-Path $evidenceDir 'latest.md'), $md)

    if (-not $suitePassed) { throw 'TLC suite outcome or vacuity audit did not match expectations; inspect evidence/latest.json.' }
} finally {
    if ([IO.Directory]::Exists($runTmp)) {
        [IO.Directory]::Delete($runTmp, $true)
    }
    if ([IO.Directory]::Exists($taskTmpRoot) -and
        -not [IO.Directory]::EnumerateFileSystemEntries($taskTmpRoot).GetEnumerator().MoveNext()) {
        [IO.Directory]::Delete($taskTmpRoot, $false)
    }
}

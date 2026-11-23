param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$BridgePath,
    [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source
)

$ErrorActionPreference = 'Stop'
$cli = Join-Path $PSScriptRoot 'cli.mjs'
$dispatch = Join-Path $PSScriptRoot 'comet-dispatch.mjs'
$taskName = 'DualLane-Comet-Release-Agent-Pilot'
$ConfigPath = (Get-Item -LiteralPath $ConfigPath).FullName
$BridgePath = (Get-Item -LiteralPath $BridgePath).FullName
$NodePath = (Get-Item -LiteralPath $NodePath).FullName
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if ($config.mode -ne 'pilot' -or $config.channel.profile -ne 'default') {
    throw 'The Windows installer requires the pilot and the existing default Comet profile.'
}

$original = [IO.File]::ReadAllText($BridgePath)
$anchor = 'const result = await runCometCodexBridge(payload);'
$dispatchUri = ([uri]$dispatch).AbsoluteUri | ConvertTo-Json -Compress
$configLiteral = $ConfigPath | ConvertTo-Json -Compress
$hook = "const { dispatchReleaseAgent } = await import($dispatchUri);`n    const result = (await dispatchReleaseAgent(payload, $configLiteral)) ?? await runCometCodexBridge(payload);"
$alreadyInstalled = $original.Contains($hook)
if (!$alreadyInstalled -and ([regex]::Matches($original, [regex]::Escape($anchor)).Count -ne 1 -or $original.Contains('dispatchReleaseAgent'))) {
    throw 'The selected Comet bridge entry point has changed. Review its dispatcher before installing.'
}

& $NodePath $cli tick $ConfigPath
if ($LASTEXITCODE -ne 0) { throw 'The Comet coordinator preflight failed.' }

$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$arguments = '"{0}" run "{1}"' -f $cli, $ConfigPath
$created = $false
$temporary = "$BridgePath.release-agent-$([guid]::NewGuid().ToString('n')).tmp.mjs"
$backup = "$BridgePath.release-agent-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')).bak"
try {
    if ($existingTask) {
        $actions = @($existingTask.Actions)
        if ($actions.Count -ne 1 -or $actions[0].Execute -ne $NodePath -or $actions[0].Arguments -ne $arguments) {
            throw 'The existing release-agent task has a different command. Review it before replacing it.'
        }
    } else {
        $account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $action = New-ScheduledTaskAction -Execute $NodePath -Argument $arguments -WorkingDirectory $config.stateDirectory
        $principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
        Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings | Out-Null
        $created = $true
    }
    if ((Get-ScheduledTask -TaskName $taskName).State -ne 'Running') { Start-ScheduledTask -TaskName $taskName }
    for ($attempt = 0; $attempt -lt 20 -and (Get-ScheduledTask -TaskName $taskName).State -ne 'Running'; $attempt++) {
        Start-Sleep -Milliseconds 500
    }
    if ((Get-ScheduledTask -TaskName $taskName).State -ne 'Running') { throw 'The release-agent pilot worker did not start.' }
    if (!$alreadyInstalled) {
        [IO.File]::WriteAllText($temporary, $original.Replace($anchor, $hook), [Text.UTF8Encoding]::new($false))
        & $NodePath --check $temporary
        if ($LASTEXITCODE -ne 0 -or [IO.File]::ReadAllText($BridgePath) -cne $original) { throw 'Comet bridge verification failed.' }
        [IO.File]::Replace($temporary, $BridgePath, $backup)
    }
    [pscustomobject]@{ worker = $taskName; mode = 'pilot'; bridgeInstalled = $true; backup = if (!$alreadyInstalled) { $backup } }
} catch {
    if ($created) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    }
    throw
} finally {
    if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary }
}

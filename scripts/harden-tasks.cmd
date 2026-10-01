@echo off
:: ============================================================================
:: harden-tasks.cmd — adds restart-on-failure + daily catch-up trigger to the
:: orchestrateur-server and orchestrateur-watchdog tasks. RUN AS ADMINISTRATOR.
::
:: After running this, both tasks:
:: - retry up to 999 times every 1 minute if they stop unexpectedly (covers
::   the SIGHUP-from-system-services pattern observed on 17/05, 23/05, 26/05)
:: - have a secondary daily trigger at 03:00 with missed-run catch-up so any
::   prolonged outage is recovered at the next opportunity
:: ============================================================================
setlocal

for %%T in (orchestrateur-server orchestrateur-watchdog) do (
  echo === Hardening task: %%T ===
  powershell -NoProfile -Command ^
    "$s = New-ScheduledTaskSettingsSet -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 0);" ^
    "$t = Get-ScheduledTask -TaskName '%%T';" ^
    "$dailyTrigger = New-ScheduledTaskTrigger -Daily -At 3am;" ^
    "$dailyTrigger.StartBoundary = (Get-Date -Format 'yyyy-MM-ddT03:00:00');" ^
    "$triggers = @($t.Triggers) + $dailyTrigger;" ^
    "Set-ScheduledTask -TaskName '%%T' -Settings $s -Trigger $triggers;"
)

echo.
echo === Verification ===
for %%T in (orchestrateur-server orchestrateur-watchdog) do (
  echo --- %%T ---
  powershell -NoProfile -Command ^
    "$t = Get-ScheduledTask -TaskName '%%T';" ^
    "Write-Host ('RestartInterval: ' + $t.Settings.RestartInterval);" ^
    "Write-Host ('RestartCount: ' + $t.Settings.RestartCount);" ^
    "Write-Host ('StartWhenAvailable: ' + $t.Settings.StartWhenAvailable);" ^
    "Write-Host ('ExecutionTimeLimit: ' + $t.Settings.ExecutionTimeLimit);" ^
    "Write-Host 'Triggers:'; $t.Triggers | ForEach-Object { Write-Host ('  - ' + $_.CimClass.CimClassName) };"
)

echo.
echo Done. Both tasks now auto-restart if killed, and have a daily catch-up trigger.
endlocal

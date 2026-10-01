@echo off
:: ============================================================================
:: install-tasks.cmd — replaces the NSSM services with Windows Scheduled Tasks
:: that trigger on user logon. RUN AS ADMINISTRATOR.
::
:: No password required. Tasks run as the currently-logged-in user, so claude
:: finds ~/.claude correctly and Tailscale/PATH are inherited from the user
:: session.
::
:: Trade-off vs services: the server runs only while user is logged on. On a
:: dev workstation you stay logged in indefinitely, so this is fine.
:: ============================================================================
setlocal

set "ROOT=I:\orchestrateur"
set "NSSM=%ROOT%\tools\nssm.exe"
set "NODE=C:\Program Files\nodejs\node.exe"

echo === Removing NSSM services (if present) ===
"%NSSM%" stop  orchestrateur-watchdog confirm >nul 2>&1
"%NSSM%" stop  orchestrateur-server   confirm >nul 2>&1
"%NSSM%" remove orchestrateur-watchdog confirm >nul 2>&1
"%NSSM%" remove orchestrateur-server   confirm >nul 2>&1

echo === Killing any lingering node on port 7777 ===
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":7777 " ^| findstr "LISTENING"') do (
  echo Killing PID %%p
  taskkill /PID %%p /F >nul 2>&1
)

echo.
echo === Creating Scheduled Task: orchestrateur-server (on logon) ===
schtasks /create /tn "orchestrateur-server" ^
  /tr "\"%NODE%\" \"%ROOT%\server.js\"" ^
  /sc onlogon ^
  /rl HIGHEST ^
  /it ^
  /f

echo.
echo === Creating Scheduled Task: orchestrateur-watchdog (on logon, +30s delay) ===
schtasks /create /tn "orchestrateur-watchdog" ^
  /tr "\"%NODE%\" \"%ROOT%\scripts\server-watchdog.mjs\"" ^
  /sc onlogon ^
  /delay 0000:30 ^
  /rl HIGHEST ^
  /it ^
  /f

echo.
echo === Starting both immediately (don't wait for next logon) ===
schtasks /run /tn "orchestrateur-server"
timeout /t 3 /nobreak >nul
schtasks /run /tn "orchestrateur-watchdog"

echo.
echo === Status ===
schtasks /query /tn "orchestrateur-server" /v /fo LIST | findstr /i "TaskName Status Next Last Author"
echo.
schtasks /query /tn "orchestrateur-watchdog" /v /fo LIST | findstr /i "TaskName Status Next Last Author"

echo.
echo === Verification ===
timeout /t 3 /nobreak >nul
netstat -ano | findstr ":7777 " | findstr "LISTENING"
echo.
echo Manage via: Task Scheduler (taskschd.msc) — look under "Bibliothèque du Planificateur de tâches"
echo Stop a task : schtasks /end /tn "orchestrateur-server"
echo Delete     : schtasks /delete /tn "orchestrateur-server" /f
endlocal

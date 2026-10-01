@echo off
:: ============================================================================
:: install-services.cmd — register orchestrateur server + watchdog as Windows
:: services via NSSM. RUN AS ADMINISTRATOR.
::
:: After this, both processes survive console-close, machine restart, and
:: user logoff. Manage via services.msc, sc.exe, or this NSSM directly.
::
:: To uninstall:
::   nssm.exe stop  orchestrateur-server
::   nssm.exe stop  orchestrateur-watchdog
::   nssm.exe remove orchestrateur-server confirm
::   nssm.exe remove orchestrateur-watchdog confirm
:: ============================================================================
setlocal

set "ROOT=I:\orchestrateur"
set "NSSM=%ROOT%\tools\nssm.exe"
set "NODE=C:\Program Files\nodejs\node.exe"

if not exist "%NSSM%" (
  echo [error] nssm.exe not found at %NSSM%
  exit /b 1
)
if not exist "%NODE%" (
  echo [error] node.exe not found at %NODE%. Adjust NODE= in this script if your Node install is elsewhere.
  exit /b 1
)

echo === Stopping previous instances if running ===
"%NSSM%" stop  orchestrateur-server   >nul 2>&1
"%NSSM%" stop  orchestrateur-watchdog >nul 2>&1
"%NSSM%" remove orchestrateur-server   confirm >nul 2>&1
"%NSSM%" remove orchestrateur-watchdog confirm >nul 2>&1

echo === Killing any lingering node.exe on port 7777 ===
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":7777 " ^| findstr "LISTENING"') do (
  echo Killing PID %%p
  taskkill /PID %%p /F >nul 2>&1
)

echo.
echo === Installing orchestrateur-server ===
"%NSSM%" install orchestrateur-server "%NODE%" "%ROOT%\server.js"
"%NSSM%" set orchestrateur-server AppDirectory "%ROOT%"
"%NSSM%" set orchestrateur-server DisplayName "Orchestrateur — Claude Code Orchestrator"
"%NSSM%" set orchestrateur-server Description "Local orchestrator for headless Claude Code sub-agents (port 7777)"
"%NSSM%" set orchestrateur-server Start SERVICE_AUTO_START
"%NSSM%" set orchestrateur-server AppStdout "%ROOT%\logs\service-server-stdout.log"
"%NSSM%" set orchestrateur-server AppStderr "%ROOT%\logs\service-server-stderr.log"
"%NSSM%" set orchestrateur-server AppRotateFiles 1
"%NSSM%" set orchestrateur-server AppRotateBytes 10485760
"%NSSM%" set orchestrateur-server AppExit Default Restart
"%NSSM%" set orchestrateur-server AppRestartDelay 5000
:: Ensure Tailscale dir is on PATH so detectTailscaleIPv4() succeeds.
"%NSSM%" set orchestrateur-server AppEnvironmentExtra "PATH=C:\Program Files\Tailscale;%%PATH%%"

echo.
echo === Installing orchestrateur-watchdog ===
"%NSSM%" install orchestrateur-watchdog "%NODE%" "%ROOT%\scripts\server-watchdog.mjs"
"%NSSM%" set orchestrateur-watchdog AppDirectory "%ROOT%"
"%NSSM%" set orchestrateur-watchdog DisplayName "Orchestrateur Watchdog"
"%NSSM%" set orchestrateur-watchdog Description "Probes the orchestrateur-server every 10 s, restarts it on missed probes"
"%NSSM%" set orchestrateur-watchdog Start SERVICE_AUTO_START
"%NSSM%" set orchestrateur-watchdog AppStdout "%ROOT%\logs\service-watchdog-stdout.log"
"%NSSM%" set orchestrateur-watchdog AppStderr "%ROOT%\logs\service-watchdog-stderr.log"
"%NSSM%" set orchestrateur-watchdog AppRotateFiles 1
"%NSSM%" set orchestrateur-watchdog AppRotateBytes 10485760
"%NSSM%" set orchestrateur-watchdog AppExit Default Restart
"%NSSM%" set orchestrateur-watchdog AppRestartDelay 5000
"%NSSM%" set orchestrateur-watchdog DependOnService orchestrateur-server

echo.
echo === Starting both services ===
"%NSSM%" start orchestrateur-server
timeout /t 3 /nobreak >nul
"%NSSM%" start orchestrateur-watchdog

echo.
echo === Status ===
"%NSSM%" status orchestrateur-server
"%NSSM%" status orchestrateur-watchdog

echo.
echo === Done. Verify with: ===
echo   netstat -ano ^| findstr ":7777 "
echo   services.msc  (look for "Orchestrateur" entries)
echo   nssm.exe status orchestrateur-server
echo.
echo Logs: %ROOT%\logs\service-server-stdout.log
echo       %ROOT%\logs\service-watchdog-stdout.log
endlocal

# ============================================================================
# start.ps1 — bootstrap for the Claude Code Orchestrator
# ============================================================================
# Duties:
#   1. Scrub ANTHROPIC_API_KEY from this shell and any child processes.
#   2. npm install if node_modules is missing.
#   3. Generate ./.token if missing (server does it too, but we need it
#      up-front to print the URL before `node` takes over the console).
#   4. Print the tokenized localhost + tailscale URLs.
#   5. Open the default browser at the localhost URL (after a short delay
#      so the server has a chance to bind).
#   6. Launch node server.js in the foreground (blocking, Ctrl+C to quit).
# ============================================================================

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# 1. Scrub API key in this session (server also does this, double-safety).
Remove-Item -Path Env:\ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

# 2. Install dependencies if missing.
if (-not (Test-Path -Path 'node_modules')) {
    Write-Host '[start] installing dependencies (first run)...' -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# 3. Ensure .token exists and is well-formed.
$tokenPath = Join-Path $PSScriptRoot '.token'
$token = $null
if (Test-Path $tokenPath) {
    $token = (Get-Content -Path $tokenPath -Raw).Trim()
    if ($token -notmatch '^[0-9a-f]{64}$') { $token = $null }
}
if (-not $token) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    Set-Content -Path $tokenPath -Value $token -NoNewline -Encoding ascii
}

# 4. Detect tailscale IP (best effort).
$tsIp = $null
try {
    $tsOut = & tailscale ip -4 2>$null
    if ($LASTEXITCODE -eq 0 -and $tsOut) {
        $firstLine = ($tsOut -split "`r?`n")[0].Trim()
        if ($firstLine -match '^\d+\.\d+\.\d+\.\d+$') { $tsIp = $firstLine }
    }
} catch { }

# 5. Print the URLs.
$port = 7777
$localUrl = "http://127.0.0.1:$port/?token=$token"
$tsUrl = if ($tsIp) { "http://${tsIp}:${port}/?token=$token" } else { $null }

Write-Host ''
Write-Host 'Dashboard URLs:' -ForegroundColor Cyan
Write-Host "  localhost : $localUrl"
if ($tsUrl) { Write-Host "  tailscale : $tsUrl" }
else        { Write-Host '  tailscale : not detected' -ForegroundColor DarkGray }
Write-Host ''

# 6. Open browser after a short delay so the server binds first.
Start-Job -ScriptBlock {
    param($u) Start-Sleep -Seconds 2
    Start-Process $u
} -ArgumentList $localUrl | Out-Null

# 7. Launch the server (blocks until Ctrl+C).
& node server.js
exit $LASTEXITCODE

@echo off
rem Ollama Cockpit launcher: starts the telemetry server (also reachable from phones on the
rem same Wi-Fi, with an access key) and opens the HUD in the browser.
title Ollama Cockpit
cd /d "%~dp0"
where deno >nul 2>nul || (
  echo Deno not found. Install it with:  winget install DenoLand.Deno
  pause
  exit /b 1
)
deno run --allow-net --allow-read --allow-run --allow-env --allow-sys=networkInterfaces --allow-write=.cockpit-key server.ts --open --lan
if errorlevel 1 pause

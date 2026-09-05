@echo off
title APEX
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Download it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

echo Starting APEX...
start "" http://127.0.0.1:4173
node server.mjs
pause

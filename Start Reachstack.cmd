@echo off
rem Starts Reachstack on this computer and opens it in the browser (see tools\start-local.mjs).
title Reachstack
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Reachstack needs Node.js 22.12 or newer: install the LTS from https://nodejs.org, then start it again.
  echo.
  pause
  exit /b 1
)
node tools\start-local.mjs %*
if errorlevel 1 pause

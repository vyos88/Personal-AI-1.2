@echo off
REM Keeps the alpha-tunnel agent attached. Same reasoning as
REM run-coordinator.cmd: the pair died last time because both were terminal
REM windows and the windows were closed.
cd /d C:\services\alpha-tunnel
REM Let the coordinator claim its port first on a cold boot. The agent retries
REM anyway, but starting into a refused connection just fills the log.
timeout /t 20 /nobreak >nul
:loop
node src\agent\index.js >> "%LOCALAPPDATA%\alpha-tunnel-agent.log" 2>&1
timeout /t 10 /nobreak >nul
goto loop

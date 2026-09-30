@echo off
REM Keeps the alpha-tunnel coordinator up without a person holding a terminal
REM open. Installing it as a real Windows service (nssm) needs elevation and is
REM still the better answer; this is the unelevated equivalent.
REM
REM The loop is the point: node exiting for any reason -- a crash, a port
REM conflict that clears, an OOM kill -- comes straight back instead of leaving
REM the host silently absent, which is how the pair was lost before.
cd /d C:\services\alpha-tunnel
:loop
node src\host\index.js >> "%LOCALAPPDATA%\alpha-tunnel-coordinator.log" 2>&1
REM A tight restart loop on a permanent failure would spin the CPU and fill the
REM log, so back off before trying again.
timeout /t 10 /nobreak >nul
goto loop

# Handoff: to Claude on Worker1 (Laptop41), 2026-10-06 evening

**For:** a Claude Code session running on Laptop41 (Worker1, DESKTOP-41HPLCN).
**From:** the cloud Claude session (`claude/dazzling-meitner-wr7g6d`).
**Covers:** the owner's 9 recommendations and 9 improvements to the fleet status report (`docs/BACKLOG.md`, R1-R11).
**Where the owner is:** on the Host (gj8), using Alpha through the desktop app, which opens alpha-ai.uk.

**Standing rule:** post in the coordination tunnel before and after you work:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\scripts\alpha_coordination_tunnel.ps1 -Action Post -Actor claude-code -Message "<what you are starting or finished>"
```

Never print or commit secrets: passwords, keys, `.env` contents, WiFi keys.

## 0. First

1. `$env:COMPUTERNAME` must be `DESKTOP-41HPLCN`. If it is not, stop and say so.
2. Run `git -C C:\services\alpha-tunnel pull`.
3. Post that you are starting.

## 1. CrowPanel: the backend is not on the home network (recommendation 4)

**What the doctor saw at 18:11 UTC:** the backend listens only on `::1`, `100.69.243.25` and `127.0.0.1`. This machine's Wi-Fi address is `192.168.2.151`. Nothing on the home network has called the backend.

Still true at 21:56 UTC: the doctor's section 6 has the same three lines, open for 13 runs.

`scripts/fix-panel-host.mjs` (merged to `main` with #144 at 20:23 UTC) now does steps 1-4 below in one command. It adds the home address to `HOST` and `ALPHA_TRUSTED_HOSTS` and turns on `ALPHA_PANEL_LAN_READ`, keeping every address already listed. It backs the file up, restarts 'Alpha Backend', then requests the deck feed from `192.168.2.151`, the same request the panel makes.

1. Find the file that holds `HOST`. Show only the matching lines, never the rest of the file:
   - `Select-String C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software\backend\.env.local, C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software\.env.local, C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\.env.local -Pattern '^(HOST|ALPHA_TRUSTED_HOSTS|ALPHA_PANEL_LAN_READ)=' -ErrorAction SilentlyContinue`
   - `Select-String C:\ProgramData\AlphaBoot\run-alpha.cmd -Pattern 'HOST|--host'`. If the wrapper passes `--host` itself, the env file is not what decides: say so and stop here.
2. Preview the change. Its default (`C:\AlphaData\Alpha\app\.env.local`) is not where Worker1's Alpha lives, so pass the file from step 1:
   `node C:\services\alpha-tunnel\scripts\fix-panel-host.mjs --env <that file> --address 192.168.2.151 --dry-run`
3. If the diff only adds `192.168.2.151` and turns the feed on, run the same command again without `--dry-run`.
4. **It succeeded when** it exits 0 and says the feed answers on `192.168.2.151`. A 400, a 404 or a refused connection each get their own reason in its output: report which one you saw.
5. Find the panel on COM4, COM7 or COM24. Open the port, wait about 20 s for it to boot, then send `STATUS`. It reports `wifi_ssid`, `wifi_set` and `alpha_base`, with no secrets.
6. If its network or its backend address is old, re-provision it:
   - send `WIFI "<ssid>" <password>`; ask the owner for the password, and never echo it;
   - then send `ALPHA http://192.168.2.151:8001`.
7. **Done when:** `Get-NetTCPConnection -LocalPort 8001 | Where-Object RemoteAddress -like '192.168.2.*'` shows the panel calling in, and the doctor's section 6 has no "listens on no home-network address" line.
8. Tell the owner to reserve `192.168.2.151` for this machine in the router, so the address cannot move again.

## 2. Voice: make Worker1's own voice the one every device hears (R8)

**Background:** Alpha speaks with Piper on the machine that runs its backend: `piper-tts==1.6.0` (in `backend/requirements.txt`) plus `.onnx` model files in `software\backend\voice_models`, which are not in git.
- When the browser gets that voice, every device sounds the same.
- When it cannot, it uses its own system voice. Edge's "Natural" voices sound good; the desktop app's do not.

**What the owner hears:** the voice is much better on Laptop41 than on the Host. That points to at least one machine on the browser's own voice, and the fix belongs here.

1. **Is Piper installed here?** Find the Python the 'Alpha Backend' task runs: `schtasks /Query /TN "Alpha Backend" /V /FO LIST`, line "Task To Run". Then run `& <that python> -c "import piper, piper.config; print('piper ok')"`.
2. **Are the models here?** Run `Get-ChildItem C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software\backend\voice_models -Filter *.onnx`. `piper_voice.py` maps the profiles to these models:
   - `en_GB-cori-high` for soft-female, the default;
   - `en_US-lessac-high`, `en_US-ryan-high` and `en_US-lessac-medium` for the others.
3. **If either is missing:**
   - install `piper-tts==1.6.0` into that Python, plus `onnxruntime-directml==1.24.4` (the pins in `requirements.txt`);
   - download the four models from Piper's voice repository, rhasspy/piper-voices on Hugging Face. Each model is an `.onnx` file plus its `.onnx.json`. Put them in `voice_models`;
   - restart only 'Alpha Backend'.
4. **Prove it:**
   - log in to Alpha's chat on this machine and make it speak; the reply should play from `/voice/synthesize` (F12, Network);
   - ask the owner to do the same on the Host through the desktop app. The `voice/synthesize` request should answer 200, and both machines should now sound the same.
   - If the Host's request fails or takes over 10 s while this machine's works, note the status and time.

## 3. The stewards' failed sign-ins (recommendation 2, R5)

#121 found 1,789 failed sign-ins from 127.0.0.1: the old stewards ("Alpha Governed Agents") holding a stale saved password.

1. Close the "Alpha Governed Agents" windows and stop the Agent Manager.
2. Wait 15 minutes, so the lockout clears.
3. The owner runs `scripts\set-alpha-local-credential.ps1` in the Alpha root, typing the password themself.
4. Start the stewards again.
5. **Done when:** `powershell -ExecutionPolicy Bypass -File C:\services\alpha-tunnel\scripts\check-alpha-logins.ps1` shows no failures in the last 15 minutes.

## 4. The coordinator admin key (recommendation 1, R2)

Ask the owner for the coordinator admin key. They paste it themself into:

```powershell
[Environment]::SetEnvironmentVariable('ALPHA_ADMIN_TOKEN', (Read-Host 'key'), 'User')
```

Never print it. **Done when:** the doctor's section 5 lists the agents with when each was last seen, rather than "Not signed in".

## 5. Keep the machine up (recommendation 9)

- Power plan: on AC, sleep and hibernate off (`powercfg /change standby-timeout-ac 0` and `powercfg /change hibernate-timeout-ac 0`).
- Windows Update active hours: ask the owner when they use Alpha, then set them.

## 6. Report back

Push a short report so the cloud session can read it. It is one file on its own branch, built the same way the doctor builds its status branch:
- branch: `status/claude-worker1`;
- file: `reports/report.md`;
- content: one line per section above (done, not done, or blocked, and why), including the voice check's results.

Then post the same summary in the coordination tunnel.

## What the cloud session is building meanwhile (no action here)

- **R9:** the doctor writes `reports/fleet-status.json` beside its text report, as one machine-readable status per laptop.
- **R10:** Alpha's `GET /fleet/status`, and a live fleet view in the tunnel hub.
- **R11:** a fleet line on the CrowPanel.

These reach this machine through the usual update path. Do not hand-edit them into the live install.

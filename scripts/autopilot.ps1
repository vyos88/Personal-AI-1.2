<#
.SYNOPSIS
  Runs the repairs a Claude session queues in this repository, so nobody has
  to paste commands into PowerShell.

.DESCRIPTION
  A cloud session cannot reach the tailnet, so until now every repair on
  Laptop41 was a block of commands for a person to paste: on the right
  laptop, in the right folder, without a stray character. This closes that
  loop. Every few minutes, on this machine only, it:

    1. fast-forwards this checkout (scripts\self-update.mjs: never over local
       work, never a merge);
    2. reads actions.json from the branch control/<channel>;
    3. runs each action it has not run before, and only from the fixed menu
       below. Anything else is refused and reported, never run;
    4. pushes what happened (exit code, the last lines of output, with
       anything secret-looking cut) to status/<channel>-autopilot.

  The menu (actions.json: {"actions":[{"id":"...","do":"...", ...}]}):
    doctor           laptop41-doctor.ps1 -Watch -Push
    repair-host      repair-alpha-host.ps1 (keeps its own rollback)
    restart-backend  stop whatever listens on Alpha's backend port, start it again
    restart-site     stop whatever listens on the site's port (4173) and its tree, start task 'Alpha' again
    stop-stray-site  stop-stray-site.ps1: stop a leftover `vite preview` tree that does not hold 4173, never the one that does (takes no arguments)
    comfyui-off      comfyui-off.ps1: stop ComfyUI here and take this machine off image work (alpha-image handlers out, agent restart); pictures go to the other machines (takes no arguments)
    songs-check      songs-check.ps1: every song in Alpha's playlist, one line each: plays as MP3, WAV only, or cannot play, with totals (reads only; takes no arguments)
    apply-update     apply-alpha-update.mjs --apply --restart   ("skipScripts": true)
    snapshot         snapshot-alpha-live.mjs --push             ("allow": "file:line,...", "includeNew": true)
    ollama-pull      ollama pull <"model">
    enable-music     enable-music.ps1: MusicGen, alpha-music handlers, agent restart  ("bridge": true, "dryRun": true)
    enable-image     enable-image.ps1: alpha-image handlers, agent restart  ("bridge": true, "installComfy": true, "backend": "a1111"|"comfyui")
    live-test        live-test-creators.mjs: real tracks, images and a reel  ("count": 1-6, "only": "music"|"image"|"video")
    promo-reel       promo-reel.mjs: a 25 s reel about Alpha into Alpha's video folder  (takes no arguments)
    ollama-keepalive ollama-keepalive.ps1: keep the chat model loaded   ("keepAlive": "24h", "model")
    brain-topology   brain-topology-check.mjs: the brain deck's links, source to served build  ("fix": true, "branch": "<alpha branch>")
    panel-host       fix-panel-host.mjs: add this machine's home-network address to Alpha's HOST, restart the backend
    interactive-first-off interactive-first-off.mjs: ALPHA_INTERACTIVE_FIRST_MODE=false in Alpha's .env.local, restart the backend  (takes no arguments)
    panel-endpoint   panel-endpoint.ps1: point the USB-attached deck at this machine's home-network backend
    panel-identify   panel-up.mjs --identify: ask each serial port which board is on it (takes no arguments)
    alpha-runtime    alpha-runtime.mjs: Alpha's loop state and its newest agent receipts with reasons (read-only)
    prepare-alpha-here  prepare-alpha-here.ps1: clone, venv, site build, chat model, cloudflared installed; starts nothing (takes no arguments)
    receive-alpha-data  receive-alpha-data.ps1: Alpha's data and .env.local from Laptop41 over Taildrop, checked by SHA-256; starts nothing
    alpha-data-in       alpha-data-in.ps1: Alpha's memory\ and artifacts\ from an alpha-move-* folder on a plugged-in drive; adds only, no .env files; starts nothing
    chat-task        chat-task.ps1: the 'Alpha Ollama' task and "chat" in selfheal.json, so self-heal restarts chat
    coord-post       coord-post.mjs: one message to Alpha's coordination log  ("message", "actor", "via": "records-standby")
    start-task       Start-ScheduledTask <"task">: Alpha, Alpha Backend, Alpha Self-Heal, Alpha Doctor
    alpha-standdown  alpha-standdown.ps1: stop serving Alpha here so the Host can (Phase 2 of the move)  ("confirm": "hand-over", or "reportOnly": true; "primary")
    alpha-standup    alpha-standdown.ps1 -Undo: serve Alpha here again, as it was  ("reportOnly": true, "force": true)
    standby-install  install-alpha-standby.ps1: Phase 3, cover for the primary automatically (a SYSTEM pass every minute)  ("primary", "primaryUrl")
    standby-uninstall  install-alpha-standby.ps1 -Uninstall: remove that task (its standby.json stays)
    data-sync        alpha-data-sync.ps1 once: send what changed in memory\ here (while serving) and apply what arrived (while not)  ("peer", "since")
    data-apply       alpha-data-sync.ps1 -ApplyHeld: stop the backend, apply what was held, start it
    tailnet-peers    tailnet-peers.ps1: the machines on the tailnet (name, address, OS, online), no accounts (takes no arguments)

  Standing check, every pass: autofix.dataSync = {"peer": "<other machine>",
  "everyMin": 10} keeps the other machine's memory\ in step (Phase 3).

  While role.json in -OpsDir says "standby" (alpha-standdown writes it), the
  actions that would start Alpha here are refused, self-heal is not restarted,
  and the live page reads STANDBY.

  Each id runs once. To run something again, queue it under a new id.

  Standing check, every pass: autofix.homeWifi = {"ssid": "<network>"} keeps
  this machine on the Wi-Fi the CrowPanel is on (see docs/AUTOPILOT.md).

  Standing check, every pass, no id needed: when actions.json carries
  {"autofix": {"brainTopology": {"branch": "<alpha branch>"}}}, the brain
  deck's links are checked on each pass and, when this machine serves the old
  deck, the fixed one is brought in from that branch (apply-alpha-update.mjs,
  with its backups and rollback). It reports only when the result changes, and
  tries a fix once per version of the deck's source.

  It refuses to run on any machine but -ExpectHost, so a copy on the wrong
  laptop does nothing.

  Install once, from an Administrator PowerShell on Laptop41:
    cd C:\services\alpha-tunnel; git pull
    powershell -ExecutionPolicy Bypass -File scripts\autopilot.ps1 -Install
  Remove:  ... scripts\autopilot.ps1 -Uninstall

  The task runs as you, elevated, while you are logged on: repairs need
  Administrator, and pushing needs your git credentials.
#>

param(
  [string]$AlphaRoot = 'C:\Users\Vyo\Downloads\VyoS-advance-tech-ai\software',
  [string]$OpsDir = 'C:\AlphaData\alpha-ops',
  [string]$ExpectHost = 'DESKTOP-41HPLCN',
  [string]$Channel = 'laptop41',
  [int]$EveryMinutes = 5,
  # How long one pass may take; the task's own time limit, read below, wins.
  [int]$PassMinutes = 100,
  [switch]$Install,
  [switch]$Uninstall,
  # Print what an actions file would run, as JSON, and run nothing.
  [string]$Plan,
  # Set by a pass that has just updated this checkout and hands the rest of
  # the pass to the new code; such a run does not update again.
  [switch]$AfterUpdate,
  # Test seam: a JSON file of facts; prints what the home Wi-Fi check would do.
  [string]$HomeWifiDecide
)

$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskName = 'Alpha Autopilot'
$tasksAllowed = @('Alpha', 'Alpha Backend', 'Alpha Self-Heal', 'Alpha Doctor')

function Ps1([string]$file, [string[]]$rest) {
  @{ exe = 'powershell.exe'; args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot $file)) + $rest }
}

# One queued action -> what to run, or why not. Never runs anything itself.
function Resolve-Action($a) {
  $id = [string]$a.id
  $do = [string]$a.do
  $out = [ordered]@{ id = $id; do = $do; ok = $false; reason = $null; exe = $null; args = @(); internal = $null; timeoutMin = 10 }
  if ($id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { $out.reason = 'id must be 1-64 letters, digits, dot, dash or underscore'; return $out }
  # A standby must not start a second Alpha: these all start or re-enable it.
  if ($standby) {
    $starts = @('restart-backend', 'restart-site', 'repair-host', 'panel-host', 'interactive-first-off')
    if ($starts -contains $do -or ($do -eq 'start-task' -and [string]$a.task -ne 'Alpha Doctor')) {
      $out.reason = "this machine is standby (role.json): Alpha serves from $($role.primary). Queue alpha-standup first"
      return $out
    }
  }
  $spec = $null
  switch ($do) {
    'doctor'          { $spec = Ps1 'laptop41-doctor.ps1' @('-Watch', '-Push', '-AlphaRoot', $AlphaRoot); $out.timeoutMin = 12 }
    'repair-host'     { $spec = Ps1 'repair-alpha-host.ps1' @('-AlphaRoot', $AlphaRoot); $out.timeoutMin = 45 }
    'restart-backend' { $out.internal = 'restart-backend'; $out.timeoutMin = 3 }
    'restart-site'    { $out.internal = 'restart-site'; $out.timeoutMin = 4 }
    'restart-coordinator' { $out.internal = 'restart-coordinator'; $out.timeoutMin = 4 }
    'apply-update' {
      $rest = @((Join-Path $PSScriptRoot 'apply-alpha-update.mjs'), '--alpha-root', $AlphaRoot, '--apply', '--restart')
      if ($a.skipScripts -eq $true) { $rest += '--skip-scripts' }
      # A host branch (this machine's live code plus fixes, alpha-from-host-*
      # based) keeps its own applied record; its first run names the commit
      # this machine matches.
      if ($a.branch) {
        if ([string]$a.branch -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$' -or [string]$a.branch -match '\.\.') { $out.reason = 'branch must be a plain branch name'; return $out }
        $rest += @('--branch', [string]$a.branch)
      }
      if ($a.from) {
        if ([string]$a.from -notmatch '^[0-9a-f]{40}$') { $out.reason = 'from must be a full 40-character commit id'; return $out }
        $rest += @('--from', [string]$a.from)
      }
      $spec = @{ exe = 'node'; args = $rest }; $out.timeoutMin = 45
    }
    'snapshot' {
      $rest = @((Join-Path $PSScriptRoot 'snapshot-alpha-live.mjs'), '--alpha-root', $AlphaRoot, '--push')
      if ($a.includeNew -eq $true) { $rest += '--include-new' }
      if ($a.allow) {
        $items = ([string]$a.allow).Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
        $bad = @($items | Where-Object { $_ -notmatch '^[A-Za-z0-9_./-]+:\d+$' })
        if ($bad.Count) { $out.reason = "allow entries must be path:line ($($bad.Count) are not)"; return $out }
        $rest += @('--allow', ($items -join ','))
      }
      $spec = @{ exe = 'node'; args = $rest }; $out.timeoutMin = 30
    }
    'enable-music' {
      $rest = @()
      if ($a.bridge -eq $true) { $rest += '-Bridge' }
      if ($a.dryRun -eq $true) { $rest += '-DryRun' }
      if ($a.machines) {
        if ([string]$a.machines -notmatch '^(auto|[A-Za-z0-9][A-Za-z0-9._-]{0,63}(,[A-Za-z0-9][A-Za-z0-9._-]{0,63})*)$') { $out.reason = 'machines must be auto or a comma list of agent names'; return $out }
        $rest += @('-Machines', [string]$a.machines)
      }
      # The first run downloads torch.
      $spec = Ps1 'enable-music.ps1' $rest; $out.timeoutMin = 60
    }
    'enable-image' {
      $rest = @()
      if ($a.bridge -eq $true) { $rest += '-Bridge' }
      if ($a.installComfy -eq $true) { $rest += '-InstallComfy' }
      if ($a.machines) {
        if ([string]$a.machines -notmatch '^(auto|[A-Za-z0-9][A-Za-z0-9._-]{0,63}(,[A-Za-z0-9][A-Za-z0-9._-]{0,63})*)$') { $out.reason = 'machines must be auto or a comma list of agent names'; return $out }
        $rest += @('-Machines', [string]$a.machines)
      }
      if ($a.backend) {
        if ([string]$a.backend -notin @('a1111', 'comfyui')) { $out.reason = 'backend must be a1111 or comfyui'; return $out }
        $rest += @('-Backend', [string]$a.backend)
      }
      if ($AlphaRoot) { $rest += @('-AlphaRoot', $AlphaRoot) }
      # ComfyUI, torch and a 4 GB checkpoint on the first run.
      $spec = Ps1 'enable-image.ps1' $rest; $out.timeoutMin = 120
    }
    'live-test' {
      $rest = @((Join-Path $PSScriptRoot 'live-test-creators.mjs'))
      if ($null -ne $a.count) {
        $n = 0
        if (-not [int]::TryParse([string]$a.count, [ref]$n) -or $n -lt 1 -or $n -gt 6) { $out.reason = 'count must be 1 to 6'; return $out }
        $rest += @('--count', "$n")
      }
      if ($a.only) {
        if ([string]$a.only -notin @('music', 'image', 'video')) { $out.reason = 'only must be music, image or video'; return $out }
        $rest += @('--only', [string]$a.only)
      }
      # The reel is made the way Alpha makes one: its renderer, with the
      # Python the backend runs (whatever listens on 8001).
      # String work, not Join-Path: -Plan runs where that drive may not exist.
      $rest += @('--video-script', (($AlphaRoot -replace '[\\/][^\\/]+[\\/]?$', '') + '\scripts\alpha_video_creator.py'))
      $held = if (Get-Command Get-NetTCPConnection -EA SilentlyContinue) { Get-NetTCPConnection -LocalPort 8001 -State Listen -EA SilentlyContinue | Select-Object -First 1 }
      $py = if ($held) { (Get-Process -Id $held.OwningProcess -EA SilentlyContinue).Path }
      if ($py) { $rest += @('--video-python', $py) }
      $spec = @{ exe = 'node'; args = $rest }; $out.timeoutMin = 45
    }
    # The owner's reel about Alpha, made the way the live test makes its reel
    # (the bridges, then Alpha's renderer with the backend's Python), and saved
    # in the folder /video/chat-artifact serves, so the Video Creator opens it.
    # Takes nothing from the action: scenes and captions live in the script.
    'promo-reel' {
      $alphaHome = $AlphaRoot -replace '[\\/][^\\/]+[\\/]?$', ''
      $rest = @((Join-Path $PSScriptRoot 'promo-reel.mjs'), '--video-script', ($alphaHome + '\scripts\alpha_video_creator.py'),
                '--out-dir', ($alphaHome + '\artifacts\generated\videos'))
      $held = if (Get-Command Get-NetTCPConnection -EA SilentlyContinue) { Get-NetTCPConnection -LocalPort 8001 -State Listen -EA SilentlyContinue | Select-Object -First 1 }
      $py = if ($held) { (Get-Process -Id $held.OwningProcess -EA SilentlyContinue).Path }
      if ($py) { $rest += @('--video-python', $py) }
      $spec = @{ exe = 'node'; args = $rest }; $out.timeoutMin = 60
    }
    'ollama-pull' {
      $model = [string]$a.model
      if ($model -notmatch '^[a-z0-9][a-z0-9._-]{0,63}(:[a-z0-9._-]{1,63})?$') { $out.reason = 'model must look like name:tag'; return $out }
      $spec = @{ exe = 'ollama'; args = @('pull', $model) }; $out.timeoutMin = 60
    }
    'ollama-keepalive' {
      $rest = @()
      if ($a.keepAlive) {
        if ([string]$a.keepAlive -notmatch '^(-1|[1-9][0-9]{0,4}[smh]?)$') { $out.reason = 'keepAlive must be -1 or a duration like 30m or 24h'; return $out }
        $rest += @('-KeepAlive', [string]$a.keepAlive)
      }
      if ($a.model) {
        if ([string]$a.model -notmatch '^[a-z0-9][a-z0-9._-]{0,63}(:[a-z0-9._-]{1,63})?$') { $out.reason = 'model must look like name:tag'; return $out }
        $rest += @('-Model', [string]$a.model)
      }
      $spec = Ps1 'ollama-keepalive.ps1' $rest; $out.timeoutMin = 10
    }
    'brain-topology' {
      $rest = @((Join-Path $PSScriptRoot 'brain-topology-check.mjs'), '--alpha-root', $AlphaRoot, '--ops', $OpsDir)
      if ($a.fix -eq $true) {
        if (-not $a.branch -or [string]$a.branch -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$' -or [string]$a.branch -match '\.\.') { $out.reason = 'fix needs branch, a plain branch name'; return $out }
        $rest += @('--fix', '--branch', [string]$a.branch, '--retry-hours', '0')
      }
      $spec = @{ exe = 'node'; args = $rest }; $out.timeoutMin = 45
    }
    # Points the CrowPanel deck plugged into this machine at this machine's
    # own home-network address. Takes nothing from the action: the URL is
    # worked out on the machine, and a Wi-Fi passphrase never travels here.
    'panel-endpoint'  { $spec = Ps1 'panel-endpoint.ps1' @(); $out.timeoutMin = 3 }
    # Which of this machine's serial ports the panel is actually on, asked of
    # the boards rather than guessed from their labels: Worker1 carries five
    # bridges and every one of them reads as "USB-SERIAL CH340". Read-only: it
    # writes one status query per port and nothing else, and takes nothing from
    # the action, so there is no path for a payload to name a port or a board.
    # Five ports at up to 30 s each, so the timeout covers the sweep.
    'panel-identify' { $spec = @{ exe = 'node'; args = @((Join-Path $PSScriptRoot 'panel-up.mjs'), '--identify') }; $out.timeoutMin = 5 }
    # The backend half of the same fix, and the one to queue first: adds this
    # machine's own home-network address to HOST and ALPHA_TRUSTED_HOSTS in
    # Alpha's .env.local (keeping every address already there, with a backup),
    # turns the deck feed on, restarts the backend and asks the feed from that
    # address. Takes nothing from the action: the address is worked out on the
    # machine and the file is the one beside -AlphaRoot, which run_server.py reads
    # (--require-host stops it if that file sets no HOST: then it is not the one).
    'panel-host' {
      # A string edit, as for live-test's video script, so -Plan works off Windows.
      $envLocal = ($AlphaRoot -replace '[\\/][^\\/]+[\\/]?$', '') + '\.env.local'
      $spec = @{ exe = 'node'; args = @((Join-Path $PSScriptRoot 'fix-panel-host.mjs'), '--env', $envLocal, '--require-host') }
      $out.timeoutMin = 4
    }
    # The owner's yes of 2026-10-07: interactive-first off, so the assistant
    # loop runs and the CrowPanel feed can go live. One owner setting, to one
    # value, in the file run_server.py reads (beside -AlphaRoot); nothing from
    # the action reaches it.
    'interactive-first-off' {
      $envLocal = ($AlphaRoot -replace '[\\/][^\\/]+[\\/]?$', '') + '\.env.local'
      $spec = @{ exe = 'node'; args = @((Join-Path $PSScriptRoot 'interactive-first-off.mjs'), '--env', $envLocal) }
      $out.timeoutMin = 5
    }
    # Why Alpha's loops or agents are where they are, from the machine. Two
    # questions needed a person at the keyboard: whether the assistant cycle is
    # running or waiting for the shared background lane (awareness runs inside it
    # and shares its gate, so "not-started" is ambiguous), and why every agent
    # receipt is incomplete (the receipt records the reason; only the class is
    # published). Read-only: one unauthenticated LAN GET and one JSON file read,
    # Alpha's root from -AlphaRoot and nothing from the action.
    'alpha-runtime' {
      $alphaHome = $AlphaRoot -replace '[\\/][^\\/]+[\\/]?$', ''
      $spec = @{ exe = 'node'; args = @((Join-Path $PSScriptRoot 'alpha-runtime.mjs'), '--alpha-root', $alphaHome) }
      $out.timeoutMin = 4
    }
    'fleet-inventory' { $spec = Ps1 'fleet-inventory.ps1' @('-AlphaRoot', $AlphaRoot); $out.timeoutMin = 3 }
    # The one stop fleet-inventory's DUPLICATES asks for on Worker1 (HANDOFF
    # 2026-10-07b section 5). Takes nothing from the action: which tree is live
    # is read off the port on the machine.
    'stop-stray-site' { $spec = Ps1 'stop-stray-site.ps1' @(); $out.timeoutMin = 2 }
    # The owner's yes of 2026-10-07 (option A): Worker1 was down to about 1 GB
    # free with its own ComfyUI holding 3.4 GB while the Host makes the
    # pictures. Takes nothing from the action: what is ComfyUI is read off the
    # machine.
    'comfyui-off' { $spec = Ps1 'comfyui-off.ps1' @(); $out.timeoutMin = 4 }
    # The owner, 2026-10-07: "a total of 85 songs check please all and make
    # them all mp3". Reads the song receipts and files only; the backend makes
    # the MP3s (Alpha cedec9d).
    'songs-check' { $spec = Ps1 'songs-check.ps1' @('-AlphaRoot', $AlphaRoot); $out.timeoutMin = 3 }
    'alpha-move-check' { $spec = Ps1 'alpha-move-check.ps1' @('-AlphaRoot', $AlphaRoot); $out.timeoutMin = 6 }
    # Phase 1 of the Alpha move on a machine that does not run Alpha yet; it
    # refuses one that does, starts nothing, and takes nothing from the payload.
    'prepare-alpha-here' { $spec = Ps1 'prepare-alpha-here.ps1' @(); $out.timeoutMin = 90 }
    # Phase 2: take what Laptop41 sent over Taildrop, check it against its
    # manifest, put it in place. Refuses while Alpha runs here; starts nothing.
    'receive-alpha-data' { $spec = Ps1 'receive-alpha-data.ps1' @(); $out.timeoutMin = 30 }
    # Chat for self-heal: a task that runs Ollama as this user, and "chat" in
    # selfheal.json naming it (Ollama started as SYSTEM finds no models).
    'chat-task' { $spec = Ps1 'chat-task.ps1' @('-OpsDir', $OpsDir); $out.timeoutMin = 4 }
    # One message to Alpha's coordination log, through the coordination handler.
    # The text travels base64-encoded so no quoting can split it into arguments.
    'coord-post' {
      $msg = [string]$a.message
      if (-not $msg.Trim() -or $msg.Length -gt 2000) { $out.reason = 'message must be 1 to 2000 characters'; return $out }
      $rest = @((Join-Path $PSScriptRoot 'coord-post.mjs'), '--message-b64', [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($msg)))
      if ($a.actor) {
        if ([string]$a.actor -notmatch '^[A-Za-z0-9._-]{1,64}$') { $out.reason = 'actor must be 1-64 letters, digits, dot, dash or underscore'; return $out }
        $rest += @('--actor', [string]$a.actor)
      }
      # "via" picks whose coordination root, from a fixed list, never a path:
      # the Host's records standby (HANDOFF_2026-10-05g) holds Alpha's notes
      # while Worker1's log is unavailable; this checkout's own .env.agent may
      # set no ALPHA_REPO_ROOT at all.
      if ($a.via) {
        $vias = @{ 'records-standby' = 'C:\services\alpha-records-standby\.env.agent' }
        if (-not $vias.ContainsKey([string]$a.via)) { $out.reason = "via must be one of: $($vias.Keys -join ', ')"; return $out }
        $rest += @('--env', $vias[[string]$a.via])
      }
      $spec = @{ exe = 'node'; args = $rest }; $out.timeoutMin = 3
    }
    # The data step of the move: copies memory\ and artifacts\ from an
    # alpha-move-* folder on a plugged-in drive into the clone. Adds only,
    # never a .env file; refuses while anything answers on 8001 here.
    'alpha-data-in' { $spec = Ps1 'alpha-data-in.ps1' @(); $out.timeoutMin = 60 }
    # Phase 2 of the move, this machine's half (HANDOFF_2026-10-07d): only with
    # V's word, said in the action, or as a rehearsal that changes nothing.
    'alpha-standdown' {
      $rest = @('-OpsDir', $OpsDir)
      if ($a.reportOnly -eq $true) { $rest += '-ReportOnly' }
      elseif ([string]$a.confirm -ne 'hand-over') { $out.reason = 'this stops Alpha here: say "confirm": "hand-over" (V present, HANDOFF_2026-10-07d Phase 2), or "reportOnly": true to rehearse'; return $out }
      if ($a.primary) {
        if ([string]$a.primary -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,62}$') { $out.reason = 'primary must be a machine name'; return $out }
        $rest += @('-Primary', [string]$a.primary)
      }
      $spec = Ps1 'alpha-standdown.ps1' $rest; $out.timeoutMin = 6
    }
    # Phase 3: automatic cover, armed only while role.json says standby or
    # covering, so it may be installed on a machine that still serves.
    'standby-install' {
      $rest = @('-OpsDir', $OpsDir, '-AlphaRoot', $AlphaRoot)
      if ($a.primary) {
        if ([string]$a.primary -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,62}$') { $out.reason = 'primary must be a machine name'; return $out }
        $rest += @('-Primary', [string]$a.primary)
      }
      if ($a.primaryUrl) {
        if ([string]$a.primaryUrl -notmatch '^https?://[A-Za-z0-9.-]+(:\d{1,5})?(/[A-Za-z0-9._/-]*)?$') { $out.reason = 'primaryUrl must be a plain http(s) URL'; return $out }
        $rest += @('-PrimaryUrl', [string]$a.primaryUrl)
      }
      $spec = Ps1 'install-alpha-standby.ps1' $rest; $out.timeoutMin = 3
    }
    'standby-uninstall' { $spec = Ps1 'install-alpha-standby.ps1' @('-OpsDir', $OpsDir, '-Uninstall'); $out.timeoutMin = 2 }
    # Phase 3's data: Alpha's memory\ between the two machines, over Taildrop,
    # checked by SHA-256, newer wins, nothing deleted (alpha-data-sync.ps1).
    'data-sync' {
      $rest = @('-OpsDir', $OpsDir, '-AlphaRoot', $AlphaRoot)
      if ($a.peer) {
        if ([string]$a.peer -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,62}$') { $out.reason = 'peer must be a machine name'; return $out }
        $rest += @('-Peer', [string]$a.peer)
      }
      if ($a.since) {
        if ((Iso-Text $a.since) -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$') { $out.reason = 'since must be a UTC time like 2026-10-07T21:00:00Z'; return $out }
        if (-not $a.peer) { $out.reason = 'since needs a peer to send to'; return $out }
        $rest += @('-Since', (Iso-Text $a.since))
      }
      # A full copy (an old "since") is gigabytes, so the job sends its first
      # part, up to the same cap as the standing check, and the check sends
      # the rest, a part a pass, without holding the pass for hours.
      $rest += @('-MaxBytes', '104857600')
      $spec = Ps1 'alpha-data-sync.ps1' $rest; $out.timeoutMin = 30
    }
    # A machine joins the fleet by joining the tailnet; its name and address
    # are what the other settings point at. Read-only, and it prints no account.
    'tailnet-peers' { $spec = Ps1 'tailnet-peers.ps1' @(); $out.timeoutMin = 2 }
    'data-apply' { $spec = Ps1 'alpha-data-sync.ps1' @('-OpsDir', $OpsDir, '-AlphaRoot', $AlphaRoot, '-ApplyHeld', '-NoSend'); $out.timeoutMin = 20 }
    'alpha-standup' {
      $rest = @('-OpsDir', $OpsDir, '-Undo')
      if ($a.reportOnly -eq $true) { $rest += '-ReportOnly' }
      if ($a.force -eq $true) { $rest += '-Force' }
      $spec = Ps1 'alpha-standdown.ps1' $rest; $out.timeoutMin = 6
    }
    'start-task' {
      $t = [string]$a.task
      if ($tasksAllowed -notcontains $t) { $out.reason = "task must be one of: $($tasksAllowed -join ', ')"; return $out }
      $out.internal = 'start-task'; $out.args = @($t); $out.timeoutMin = 2
    }
    default { $out.reason = "not on the menu: '$do'"; return $out }
  }
  if ($spec) { $out.exe = $spec.exe; $out.args = $spec.args }
  $out.ok = $true
  $out
}

# A time from JSON as ISO text: PowerShell 7 reads an ISO string in JSON as a
# date, 5.1 leaves it text, and the page and the checks must read the same.
function Iso-Text($v) {
  if ($v -is [datetime]) { return $v.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'") }
  return [string]$v
}

# Cut anything that looks like a credential before a line leaves the machine.
function Redact([string]$t) {
  # Progress bars (ollama, npm) redraw with escape codes and carriage returns:
  # keep only what the line finally said.
  $t = $t -replace '\x1b\[[0-9;?]*[A-Za-z]', ''
  if ($t.Contains("`r")) { $t = ($t -split "`r" | Where-Object { $_.Trim() } | Select-Object -Last 1) }
  $t = $t -replace 'alpha_key_[A-Za-z0-9_\-]+', 'alpha_key_...'
  $t = $t -replace '(?i)((password|passwd|token|secret|api[_-]?key|authorization)["'']?\s*[:=]\s*["'']?)[^\s"'',;]+', '$1...'
  $t = $t -replace '(?i)(bearer\s+)[A-Za-z0-9._\-]+', '$1...'
  # Long runs of letters and digits, but not a git hash or a snapshot branch name.
  [regex]::Replace($t, '[A-Za-z0-9_\-+=]{24,}', {
    param($m)
    $v = $m.Value
    if ($v -match '^[0-9a-f]{7,40}$' -or $v -match '^alpha-from-host-[0-9-]+$' -or $v -notmatch '\d' -or $v -notmatch '[A-Za-z]') { return $v }
    $v.Substring(0, 4) + "...($($v.Length))"
  })
}

# Home Wi-Fi (autofix.homeWifi): what the standing check does this pass, from
# facts read on the machine. Pure, so it is tested off Windows (-HomeWifiDecide).
function Get-HomeWifiAction($f) {
  $homeSsid = [string]$f.home
  $now = [datetime]$f.now
  $sinceMin = { param($at) if ($at) { ($now - [datetime]$at).TotalMinutes } else { [double]::MaxValue } }
  if ([string]$f.connected -ne $homeSsid) {
    $where = if ($f.connected) { "on '$($f.connected)'" } else { 'on no Wi-Fi' }
    if (-not $f.homeVisible) { return @{ action = 'none'; why = "$where; '$homeSsid' is not visible, so this network stays for the internet" } }
    if ((& $sinceMin $f.lastJoin) -lt 10) { return @{ action = 'none'; why = "$where; rejoining '$homeSsid' was tried less than 10 minutes ago" } }
    return @{ action = 'rejoin'; why = "$where while '$homeSsid' is visible: rejoining it with its saved profile" }
  }
  if ($f.standby) { return @{ action = 'none'; why = "on '$homeSsid'; standby: Alpha serves from the primary, so the backend here stays off" } }
  $ip = [string]$f.wifiIp
  if (-not $ip) { return @{ action = 'none'; why = "on '$homeSsid' with no address yet" } }
  $listen = @($f.listeners | ForEach-Object { [string]$_ })
  if ($listen -contains $ip -or $listen -contains '0.0.0.0' -or $listen -contains '::') { return @{ action = 'none'; why = "on '$homeSsid'; the backend listens on $ip" } }
  if (-not $listen.Count) { return @{ action = 'none'; why = "on '$homeSsid'; nothing listens on the backend port (self-heal restarts it)" } }
  if (@($f.hostList | ForEach-Object { [string]$_ }) -notcontains $ip) { return @{ action = 'report'; why = "on '$homeSsid'; $ip is not in the backend's address list: queue panel-host" } }
  if ((& $sinceMin $f.lastRestart) -lt 30) { return @{ action = 'none'; why = "on '$homeSsid'; the backend does not listen on $ip and was restarted less than 30 minutes ago" } }
  return @{ action = 'restart'; why = "on '$homeSsid'; the backend does not listen on ${ip}: restarting it" }
}

if ($HomeWifiDecide) {
  $f = Get-Content -LiteralPath $HomeWifiDecide -Raw | ConvertFrom-Json
  Get-HomeWifiAction $f | ConvertTo-Json -Compress
  exit 0
}

# The addresses the backend is told to bind: the boot wrapper's --host, which
# wins (run_server.py), else HOST in the .env.local beside -AlphaRoot.
function Get-BackendHosts {
  $hosts = @()
  $wrapper = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'AlphaBoot\run-alpha-backend.cmd'
  if (Test-Path -LiteralPath $wrapper) {
    foreach ($m in [regex]::Matches((Get-Content -LiteralPath $wrapper -Raw), '--host[ =](?:"([^"]*)"|([^\s"]+))')) {
      $v = if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value }
      $hosts += @($v -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    }
  }
  if (-not $hosts.Count) {
    $envFile = Join-Path (Split-Path -Parent $AlphaRoot) '.env.local'
    $hit = if (Test-Path -LiteralPath $envFile) { Select-String -LiteralPath $envFile -Pattern '^\s*HOST\s*=' -EA SilentlyContinue | Select-Object -First 1 }
    if ($hit) { $hosts = @((($hit.Line -split '=', 2)[1]).Trim().Trim('"', "'") -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
  }
  return $hosts
}

# Windows' own Wi-Fi API (WinRT), because netsh is the one tool that can also
# change profiles and this check must never do that. Nothing here reads or
# writes a passphrase: joining uses the profile Windows already saved.
function Get-WifiAdapter {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $m = [System.WindowsRuntimeSystemExtensions].GetMethods()
  $script:asOp = ($m | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $script:asAct = ($m | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
  [void][Windows.Devices.WiFi.WiFiAdapter,Windows.Devices.WiFi,ContentType=WindowsRuntime]
  [void][Windows.Networking.Connectivity.ConnectionProfile,Windows.Networking.Connectivity,ContentType=WindowsRuntime]
  $acc = $script:asOp.MakeGenericMethod([Windows.Devices.WiFi.WiFiAccessStatus]).Invoke($null, @([Windows.Devices.WiFi.WiFiAdapter]::RequestAccessAsync()))
  [void]$acc.Wait(10000)
  $t = $script:asOp.MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.Devices.WiFi.WiFiAdapter]]).Invoke($null, @([Windows.Devices.WiFi.WiFiAdapter]::FindAllAdaptersAsync()))
  if (-not $t.Wait(10000)) { return $null }
  return @($t.Result)[0]
}
function Get-WifiIp($a) {
  $nic = Get-NetAdapter -EA SilentlyContinue | Where-Object { $_.InterfaceGuid -eq "{$($a.NetworkAdapter.NetworkAdapterId)}" } | Select-Object -First 1
  if (-not $nic) { return '' }
  return [string](Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -EA SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress
}
function Get-HomeWifiFacts($a, [string]$homeSsid) {
  $f = @{ connected = ''; homeVisible = $false; wifiIp = ''; listeners = @(); hostList = @() }
  $p = $script:asOp.MakeGenericMethod([Windows.Networking.Connectivity.ConnectionProfile]).Invoke($null, @($a.NetworkAdapter.GetConnectedProfileAsync()))
  if ($p.Wait(10000) -and $p.Result -and $p.Result.WlanConnectionProfileDetails) { $f.connected = [string]$p.Result.WlanConnectionProfileDetails.GetConnectedSsid() }
  if ($f.connected -ne $homeSsid) {
    [void]$script:asAct.Invoke($null, @($a.ScanAsync())).Wait(20000)
    $f.homeVisible = [bool]($a.NetworkReport.AvailableNetworks | Where-Object { $_.Ssid -eq $homeSsid })
  }
  $f.wifiIp = Get-WifiIp $a
  $f.listeners = @(Get-NetTCPConnection -LocalPort 8001 -State Listen -EA SilentlyContinue | ForEach-Object { [string]$_.LocalAddress } | Sort-Object -Unique)
  $f.hostList = @(Get-BackendHosts)
  return $f
}
function Join-HomeWifi($a, [string]$homeSsid) {
  $net = $a.NetworkReport.AvailableNetworks | Where-Object { $_.Ssid -eq $homeSsid } | Sort-Object NetworkRssiInDecibelMilliwatts -Descending | Select-Object -First 1
  if (-not $net) { return 'not visible any more' }
  $c = $script:asOp.MakeGenericMethod([Windows.Devices.WiFi.WiFiConnectionResult]).Invoke($null, @($a.ConnectAsync($net, [Windows.Devices.WiFi.WiFiReconnectionKind]::Automatic)))
  if (-not $c.Wait(60000)) { return 'no answer within 60 s' }
  $status = [string]$c.Result.ConnectionStatus
  if ($status -eq 'Success') { for ($i = 0; $i -lt 12 -and -not (Get-WifiIp $a); $i++) { Start-Sleep -Seconds 5 } }
  return "$status ($($net.NetworkRssiInDecibelMilliwatts) dBm)"
}

# Stop whatever listens on the backend port and start it again: the
# restart-backend action, and the home Wi-Fi check when the backend did not
# bind the address the panel calls.
function Restart-Backend {
  $port = 8001
  $portFile = Join-Path (Split-Path -Parent $AlphaRoot) 'memory\local\backend.port'
  if (Test-Path -LiteralPath $portFile) { $n = 0; if ([int]::TryParse((Get-Content -LiteralPath $portFile -Raw).Trim(), [ref]$n)) { $port = $n } }
  $lines = New-Object System.Collections.ArrayList
  $held = Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue | Select-Object -First 1
  if ($held) { Stop-Process -Id $held.OwningProcess -Force -EA SilentlyContinue; [void]$lines.Add("stopped pid $($held.OwningProcess) on $port") }
  else { [void]$lines.Add("nothing listened on $port") }
  Start-Sleep -Seconds 5
  if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue)) {
    if (Get-ScheduledTask -TaskName 'Alpha Backend' -EA SilentlyContinue) { Start-ScheduledTask -TaskName 'Alpha Backend'; [void]$lines.Add("started task 'Alpha Backend'") }
    else {
      $startLocal = Join-Path (Split-Path -Parent $AlphaRoot) 'scripts\start-local.ps1'
      if (Test-Path -LiteralPath $startLocal) {
        Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$startLocal`"") -WindowStyle Minimized -WorkingDirectory (Split-Path -Parent $AlphaRoot)
        [void]$lines.Add('started scripts\start-local.ps1')
      } else { [void]$lines.Add('no Alpha Backend task and no start-local.ps1: nothing to start it with') }
    }
  } else { [void]$lines.Add('something already restarted it') }
  $deadline = (Get-Date).AddSeconds(150)
  while ((Get-Date) -lt $deadline -and -not (Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue)) { Start-Sleep -Seconds 5 }
  $up = [bool](Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue)
  [void]$lines.Add($(if ($up) { "backend listening on $port" } else { "backend NOT listening on $port after 150s" }))
  return @{ code = $(if ($up) { 0 } else { 1 }); text = ($lines -join "`n") }
}

# role.json (alpha-standdown.ps1): "standby" while another machine serves Alpha.
function Read-Role {
  $f = Join-Path $OpsDir 'role.json'
  if (-not (Test-Path -LiteralPath $f)) { return $null }
  try { return (Get-Content -LiteralPath $f -Raw) -replace '^\uFEFF', '' | ConvertFrom-Json } catch { return $null }
}
$role = Read-Role
$standby = [bool]($role -and [string]$role.role -eq 'standby')

if ($Plan) {
  $doc = Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json
  $plans = @(@($doc.actions) | Where-Object { $_ } | ForEach-Object { Resolve-Action $_ })
  ConvertTo-Json -InputObject $plans -Depth 5 -Compress
  exit 0
}

if ($env:COMPUTERNAME -and $ExpectHost -and $env:COMPUTERNAME -ne $ExpectHost) {
  Write-Host "This is $env:COMPUTERNAME, not ${ExpectHost}: the autopilot does nothing here." -ForegroundColor Yellow
  exit 3
}

# ------------------------------------------------------------ install
if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -EA SilentlyContinue
  Write-Host "removed '$taskName'"
  exit 0
}
if ($Install) {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) { Write-Host 'Run this from an Administrator PowerShell (repairs need it).' -ForegroundColor Red; exit 1 }
  # A machine without Alpha (the Host runs the coordinator and an agent) still
  # gets the actions that need none: enable-music, ollama-*.
  if (-not (Test-Path -LiteralPath $AlphaRoot)) { Write-Host "No Alpha at ${AlphaRoot}: actions that need Alpha (doctor, apply-update, snapshot, restart-backend) will fail here; the rest work." -ForegroundColor Yellow }
  $argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -AlphaRoot `"$AlphaRoot`" -OpsDir `"$OpsDir`" -ExpectHost `"$ExpectHost`" -Channel `"$Channel`""
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory $repo
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
                -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 6)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  Write-Host "installed '$taskName': every $EveryMinutes minutes, runs what control/$Channel queues, reports to status/$Channel-autopilot." -ForegroundColor Green
  Write-Host "remove: powershell -ExecutionPolicy Bypass -File scripts\autopilot.ps1 -Uninstall"
  exit 0
}

# ------------------------------------------------------------ one pass
$dir = Join-Path $OpsDir 'autopilot'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$statePath = Join-Path $dir 'state.json'
$state = $null
if (Test-Path -LiteralPath $statePath) { try { $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { } }
$done = [ordered]@{}
if ($state -and $state.done) { foreach ($p in $state.done.PSObject.Properties) { $done[$p.Name] = $p.Value } }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$passStart = Get-Date
# Entries that ran in a pass that never got to report (the task's time limit
# stopped it): they are reported by this one.
$pending = @()
if ($state -and $state.pending) { $pending = @($state.pending) }

# Task Scheduler stops a pass at the task's time limit, and on 2026-10-06
# Worker1's queue (music, the route update, images, a live test) needed more
# than the 2 hours it was installed with. A pass that is stopped loses nothing
# now (progress is saved after every action), but it should not be stopped:
# raise the limit to 6 hours once, and plan this pass inside whatever it is.
if (Get-Command Get-ScheduledTask -EA SilentlyContinue) {
  try {
    $self = Get-ScheduledTask -TaskName $taskName -EA Stop
    $limit = [string]$self.Settings.ExecutionTimeLimit
    $span = if ($limit -and $limit -ne 'PT0S') { [Xml.XmlConvert]::ToTimeSpan($limit) } else { [TimeSpan]::FromHours(10) }
    if ($span.TotalHours -lt 6) {
      $self.Settings.ExecutionTimeLimit = 'PT6H'
      Set-ScheduledTask -InputObject $self -EA Stop | Out-Null
      Write-Host "raised '$taskName' time limit from $limit to 6 hours"
      # This pass still runs under the old limit.
    }
    $PassMinutes = [math]::Max(20, [int]$span.TotalMinutes - 10)
  } catch { }
}

# 1. Current code first: a new action on the menu arrives with the code that runs it.
if ($AfterUpdate) { $update = ''; $updateExit = 0 }
else {
  $update = & node (Join-Path $PSScriptRoot 'self-update.mjs') --repo $repo 2>&1 | Out-String
  $updateExit = $LASTEXITCODE
}
if ($updateExit -eq 10) {
  # The checkout moved under this pass. Stopping here left the pass silent:
  # on 2026-10-07 main moved every few minutes from 02:15 to 02:30 UTC, and
  # four passes in a row updated and stopped with no action run and no report
  # (not even the live report, which exists to say the reporter is alive).
  # The rest of the pass runs with the new code instead, in a new process,
  # once: that run does not update again.
  Write-Host 'updated this checkout; running the rest of this pass with the new code'
  $forward = @()
  foreach ($k in $PSBoundParameters.Keys) {
    $v = $PSBoundParameters[$k]
    if ($v -is [System.Management.Automation.SwitchParameter]) { if ($v.IsPresent) { $forward += "-$k" } }
    else { $forward += @("-$k", [string]$v) }
  }
  & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath @forward -AfterUpdate
  exit $LASTEXITCODE
}
# A checkout that cannot update is silent otherwise, and every fix sent through
# this repository then stops reaching the machine. Say why, in every report.
$head = (git -C $repo rev-parse --short HEAD 2>$null | Out-String).Trim()
$checkoutNote = "checkout $head is current"
if ($updateExit -ne 0) {
  $why = ($update -split "`r?`n" | Where-Object { $_ -match 'reason|refus|uncommitted|diverg|fail|error' } | Select-Object -First 3) -join ' / '
  $paths = @(git -C $repo status --porcelain 2>$null | Select-Object -First 15)
  $checkoutNote = "checkout $head did NOT update (self-update exit $updateExit): $why" +
    $(if ($paths.Count) { "; local changes: " + ($paths -join ', ') } else { '' })
}

# 2. What is queued.
# Nothing queued is not a reason to stop here: a checkout that cannot update
# is still reported below.
$queued = @()
$control = $null
git -C $repo fetch -q origin "control/$Channel" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "nothing queued (no control/$Channel branch)" }
else {
  $raw = git -C $repo show 'FETCH_HEAD:actions.json' 2>$null | Out-String
  if (-not $raw.Trim()) { Write-Host 'nothing queued' }
  else {
    try { $control = ConvertFrom-Json $raw; $queued = @(@($control.actions) | Where-Object { $_ }) } catch { Write-Host "actions.json does not parse: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
  }
}

# 2b. The bridges come back by themselves. Both are logon tasks on this
# machine; on 2026-10-06 the music (8790) and image (7861) bridges were found
# down together, and Alpha's IMAGE_GEN_URL points through 7861, so chat images
# failed until someone noticed. A registered bridge task with nothing on its
# port is started again here, before any queued action (a live test needs them).
$ran = New-Object System.Collections.ArrayList
$bridgeLines = New-Object System.Collections.ArrayList
if ((Get-Command Get-ScheduledTask -EA SilentlyContinue) -and (Get-Command Get-NetTCPConnection -EA SilentlyContinue)) {
  foreach ($b in @(@{ task = 'alpha-music bridge'; port = 8790; log = 'alpha-music-bridge.log' }, @{ task = 'alpha-image bridge'; port = 7861; log = 'alpha-image-bridge.log' })) {
    $registered = Get-ScheduledTask -TaskName $b.task -EA SilentlyContinue
    if (-not $registered) { continue }
    if (Get-NetTCPConnection -LocalPort $b.port -State Listen -EA SilentlyContinue) { continue }
    # Why it went down, before it is restarted: whether the launcher loop was
    # still running (only node died) or the whole task was ended, and the end
    # of its log. Keys are masked; the bridges never log them, but be sure.
    $info = Get-ScheduledTaskInfo -TaskName $b.task -EA SilentlyContinue
    [void]$bridgeLines.Add("'$($b.task)' task was $($registered.State); last run $($info.LastRunTime), last result 0x$('{0:X}' -f [int64]$info.LastTaskResult)")
    $logFile = Join-Path $env:TEMP $b.log
    if (Test-Path -LiteralPath $logFile) {
      Get-Content -LiteralPath $logFile -Tail 6 -EA SilentlyContinue | ForEach-Object {
        $line = ("$_" -replace '(alpha_key_|sk-|ghp_|github_pat_)\S+', '$1***' -replace '[A-Za-z0-9+/_=-]{32,}', '***')
        [void]$bridgeLines.Add("  log: $($line.Substring(0, [math]::Min(200, $line.Length)))")
      }
    } else { [void]$bridgeLines.Add("  no log at $logFile") }
    # A launcher loop that is still running but whose node died cannot be
    # told apart from outside: end the task's instance, then start it fresh.
    Stop-ScheduledTask -TaskName $b.task -EA SilentlyContinue
    Start-ScheduledTask -TaskName $b.task -EA SilentlyContinue
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline -and -not (Get-NetTCPConnection -LocalPort $b.port -State Listen -EA SilentlyContinue)) { Start-Sleep -Seconds 3 }
    $up = [bool](Get-NetTCPConnection -LocalPort $b.port -State Listen -EA SilentlyContinue)
    [void]$bridgeLines.Add("'$($b.task)' was not listening on $($b.port): restarted, " + $(if ($up) { 'it answers now' } else { "still nothing on $($b.port) after 45s (its log is in %TEMP%)" }))
  }
}
if ($bridgeLines.Count) {
  [void]$ran.Add([ordered]@{ id = "auto-bridges-$stamp"; do = 'bridges (standing)'; result = $(if (($bridgeLines -join ' ') -match 'still nothing') { '1 (still down)' } else { '0 (restarted)' }); at = (Get-Date).ToString('s'); seconds = 0; tail = ($bridgeLines -join "`n") })
  $bridgeLines | ForEach-Object { Write-Host $_ }
}

# 3. Run what has not run.
$queuedRan = 0
foreach ($a in $queued) {
  $p = Resolve-Action $a
  if (-not $p.id -or $done.Contains($p.id)) { continue }
  # One long action may run past the plan, but none starts that would not fit:
  # it waits for the next pass, and so does everything queued after it.
  $elapsed = ((Get-Date) - $passStart).TotalMinutes
  if ($queuedRan -and $p.ok -and ($elapsed + [int]$p.timeoutMin) -gt $PassMinutes) {
    Write-Host ("{0} {1}: deferred to the next pass ({2:N0} of {3} minutes used, it may take {4})" -f $p.id, $p.do, $elapsed, $PassMinutes, $p.timeoutMin)
    break
  }
  $started = Get-Date
  $log = Join-Path $dir "$stamp-$($p.id).log"
  $code = $null
  $text = ''
  if (-not $p.ok) {
    $code = 'refused'; $text = $p.reason
  } elseif ($p.internal -eq 'start-task') {
    try { Start-ScheduledTask -TaskName $p.args[0] -EA Stop; $code = 0; $text = "started '$($p.args[0])'" } catch { $code = 1; $text = $_.Exception.Message }
  } elseif ($p.internal -eq 'restart-site') {
    # Stop-ScheduledTask ends the task's cmd.exe and can leave the preview
    # server on the port: then the task cannot start a new one, and the old
    # one keeps serving its old vite.config (Worker1, 2026-10-06: /music 404).
    $port = 4173
    $lines = New-Object System.Collections.ArrayList
    Stop-ScheduledTask -TaskName 'Alpha' -EA SilentlyContinue
    $held = @(Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue | ForEach-Object OwningProcess | Select-Object -Unique)
    foreach ($procId in $held) { taskkill.exe /T /F /PID $procId 2>&1 | Out-Null; [void]$lines.Add("stopped pid $procId (and its children) on $port") }
    if (-not $held.Count) { [void]$lines.Add("nothing listened on $port") }
    Start-Sleep -Seconds 3
    if (Get-ScheduledTask -TaskName 'Alpha' -EA SilentlyContinue) { Start-ScheduledTask -TaskName 'Alpha'; [void]$lines.Add("started task 'Alpha'") }
    else { [void]$lines.Add("no task 'Alpha' to start the site with") }
    $deadline = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $deadline -and -not (Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue)) { Start-Sleep -Seconds 5 }
    $now = @(Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue | ForEach-Object OwningProcess | Select-Object -Unique)
    $up = [bool]$now.Count
    [void]$lines.Add($(if ($up) { "site listening on $port (pid $($now -join ', '))" } else { "site NOT listening on $port after 180s" }))
    if ($up) {
      $music = ''
      foreach ($scheme in 'https', 'http') { if (-not $music) { $music = (& curl.exe -s -k --max-time 10 "${scheme}://127.0.0.1:$port/music/healthz" 2>$null | Out-String).Trim() } }
      [void]$lines.Add("/music/healthz through the site: $(if ($music -match '"ok"\s*:\s*true') { 'the music bridge answers' } elseif ($music) { $music.Substring(0, [math]::Min(120, $music.Length)) } else { 'no answer' })")
    }
    $code = $(if ($up) { 0 } else { 1 }); $text = $lines -join "`n"
  } elseif ($p.internal -eq 'restart-coordinator') {
    # The coordinator runs as the scheduled task 'alpha-coordinator' on the
    # Host. A git pull does not reach it: the 2026-10-07 pull of #159 left it
    # on the old code (LastRunTime 2026-10-06) until something restarted it.
    # The queue survives (data/tasks.json); agents re-register by themselves.
    $port = 8787
    $n = 0; if ($env:ALPHA_HOST_PORT -and [int]::TryParse($env:ALPHA_HOST_PORT, [ref]$n)) { $port = $n }
    $lines = New-Object System.Collections.ArrayList
    if (-not (Get-ScheduledTask -TaskName 'alpha-coordinator' -EA SilentlyContinue)) {
      $code = 1; $text = "no scheduled task 'alpha-coordinator' on $env:COMPUTERNAME: the coordinator does not run here"
    } else {
      Stop-ScheduledTask -TaskName 'alpha-coordinator' -EA SilentlyContinue
      $held = @(Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue | ForEach-Object OwningProcess | Select-Object -Unique)
      foreach ($procId in $held) { taskkill.exe /T /F /PID $procId 2>&1 | Out-Null; [void]$lines.Add("stopped pid $procId (and its children) on $port") }
      if (-not $held.Count) { [void]$lines.Add("nothing listened on $port") }
      Start-Sleep -Seconds 3
      Start-ScheduledTask -TaskName 'alpha-coordinator'
      [void]$lines.Add("started task 'alpha-coordinator' from checkout $((git -C $repo rev-parse --short HEAD 2>$null | Out-String).Trim())")
      $deadline = (Get-Date).AddSeconds(150)
      while ((Get-Date) -lt $deadline -and -not (Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue)) { Start-Sleep -Seconds 5 }
      $listen = Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue | Select-Object -First 1
      if ($listen) {
        $addr = if ($listen.LocalAddress -in @('0.0.0.0', '::')) { '127.0.0.1' } else { $listen.LocalAddress }
        $health = (& curl.exe -s --max-time 10 "http://${addr}:$port/healthz" 2>$null | Out-String).Trim()
        [void]$lines.Add("coordinator listening on ${addr}:$port; healthz: $(if ($health) { $health.Substring(0, [math]::Min(120, $health.Length)) } else { 'no answer' })")
        $code = $(if ($health -match '"ok"\s*:\s*true') { 0 } else { 1 })
      } else {
        [void]$lines.Add("coordinator NOT listening on $port after 150s")
        $code = 1
      }
      $text = $lines -join "`n"
    }
  } elseif ($p.internal -eq 'restart-backend') {
    $r = Restart-Backend; $code = $r.code; $text = $r.text
  } else {
    $errLog = "$log.err"
    try {
      $quoted = $p.args | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
      $proc = Start-Process -FilePath $p.exe -ArgumentList $quoted -WorkingDirectory $repo -NoNewWindow -PassThru `
                -RedirectStandardOutput $log -RedirectStandardError $errLog
      # Without a handle taken now, .NET drops the exit code once the process
      # ends, and ExitCode reads back empty: the first report showed "->" with
      # no result for every action.
      $null = $proc.Handle
      if ($proc.WaitForExit([int]$p.timeoutMin * 60000)) { $code = $proc.ExitCode }
      else { Stop-Process -Id $proc.Id -Force -EA SilentlyContinue; $code = "timeout after $($p.timeoutMin) min" }
    } catch { $code = 'could not start'; Set-Content -LiteralPath $errLog -Value $_.Exception.Message }
    # -Raw: line by line, Get-Content also splits at a bare carriage return,
    # and a progress bar's redraws would come back as separate lines.
    $text = (@(Get-Content -LiteralPath $log -Raw -EA SilentlyContinue) + @(Get-Content -LiteralPath $errLog -Raw -EA SilentlyContinue) | Where-Object { $_ }) -join "`n"
  }
  if ($p.internal -or -not $p.ok) { Set-Content -LiteralPath $log -Value $text }
  $prev = $null
  $tail = (($text -split "`n") | ForEach-Object { Redact $_ } | Where-Object { $_.Trim() } |
           Where-Object { $same = ($_ -eq $prev); $prev = $_; -not $same } | Select-Object -Last 60) -join "`n"
  $entry = [ordered]@{ id = $p.id; do = $p.do; result = "$code"; at = $started.ToString('s'); seconds = [int]((Get-Date) - $started).TotalSeconds; tail = $tail }
  $done[$p.id] = [ordered]@{ result = "$code"; at = $entry.at }
  [void]$ran.Add($entry)
  $queuedRan++
  Write-Host ("{0} {1}: {2}" -f $p.id, $p.do, $code)
  # Saved now, not at the end: a pass stopped by the task's time limit would
  # otherwise run every action of it again on the next pass.
  $mid = [ordered]@{ done = $done; history = @($state.history | Where-Object { $_ }); lastRun = (Get-Date).ToString('s'); checkoutNote = $(if ($state) { [string]$state.checkoutNote } else { '' }); brainKey = $(if ($state) { [string]$state.brainKey } else { '' }); syncKey = $(if ($state) { [string]$state.syncKey } else { '' }); deckKey = $(if ($state) { [string]$state.deckKey } else { '' }); deckAt = $(if ($state) { [string]$state.deckAt } else { '' }); auditAt = $(if ($state) { [string]$state.auditAt } else { '' }); watchKey = $(if ($state) { [string]$state.watchKey } else { '' }); homeWifiKey = $(if ($state) { [string]$state.homeWifiKey } else { '' }); homeWifiJoinAt = $(if ($state) { [string]$state.homeWifiJoinAt } else { '' }); homeWifiRestartAt = $(if ($state) { [string]$state.homeWifiRestartAt } else { '' }); dataSyncKey = $(if ($state) { [string]$state.dataSyncKey } else { '' }); dataSyncAt = $(if ($state) { [string]$state.dataSyncAt } else { '' }); pending = @(@($ran) + $pending) }
  $mid | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding UTF8
}

# 3b. Standing checks: run every pass, report only a change.
$brainKey = if ($state -and $state.brainKey) { [string]$state.brainKey } else { '' }
$brainBranch = $null
if ($control -and $control.autofix -and $control.autofix.brainTopology -and $control.autofix.brainTopology.branch) { $brainBranch = [string]$control.autofix.brainTopology.branch }
if ($brainBranch -and (Test-Path -LiteralPath $AlphaRoot)) {
  if ($brainBranch -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$' -or $brainBranch -match '\.\.') { Write-Host 'autofix.brainTopology.branch is not a plain branch name: skipped' }
  else {
    $started = Get-Date
    $text = (& node (Join-Path $PSScriptRoot 'brain-topology-check.mjs') --alpha-root $AlphaRoot --ops $OpsDir --fix --branch $brainBranch 2>&1 | Out-String)
    $code = $LASTEXITCODE
    # What the deck's state is, without the run-to-run detail (times, paths).
    $key = "$code " + (($text -split "`r?`n" | Where-Object { $_ -match '^(OK|PROBLEM|AFTER FIX)' }) -join ' | ')
    if ($key -ne $brainKey) {
      $tail = (($text -split "`r?`n") | ForEach-Object { Redact $_ } | Where-Object { $_.Trim() } | Select-Object -Last 40) -join "`n"
      $result = switch ($code) { 0 { '0 (deck ok)' } 2 { '0 (fixed)' } default { "$code (open)" } }
      [void]$ran.Add([ordered]@{ id = "auto-brain-topology-$stamp"; do = 'brain-topology (standing)'; result = $result; at = $started.ToString('s'); seconds = [int]((Get-Date) - $started).TotalSeconds; tail = $tail })
      Write-Host "brain topology: $result"
    }
    $brainKey = $key
  }
}

# Live sync (docs/LIVE_SYNC.md): delivers the live branch to this machine and,
# with "capture": true, pushes what this machine runs back to it. Turned on by
# autofix.liveSync in actions.json; reported only when its state changes.
$syncKey = if ($state -and $state.syncKey) { [string]$state.syncKey } else { '' }
$sync = if ($control -and $control.autofix -and $control.autofix.liveSync -and $control.autofix.liveSync.branch) { $control.autofix.liveSync } else { $null }
if ($sync -and (Test-Path -LiteralPath $AlphaRoot)) {
  $syncBranch = [string]$sync.branch
  if ($syncBranch -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$' -or $syncBranch -match '\.\.') { Write-Host 'autofix.liveSync.branch is not a plain branch name: skipped' }
  else {
    $started = Get-Date
    $syncArgs = @((Join-Path $PSScriptRoot 'live-sync.mjs'), '--alpha-root', $AlphaRoot, '--ops', $OpsDir, '--branch', $syncBranch)
    if ($env:COMPUTERNAME) { $syncArgs += @('--machine', $env:COMPUTERNAME) }
    if ($sync.capture -eq $true) { $syncArgs += '--capture' }
    if ($sync.skipScripts -eq $true) { $syncArgs += '--skip-scripts' }
    # The owner's approved credential-scan lines, exactly as the snapshot action takes them.
    $syncAllow = @()
    if ($sync.allow) { $syncAllow = @((@($sync.allow) -join ',').Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
    $badAllow = @($syncAllow | Where-Object { $_ -notmatch '^[A-Za-z0-9_./-]+:\d+$' })
    if ($badAllow.Count) { Write-Host "autofix.liveSync.allow entries must be path:line ($($badAllow.Count) are not): none used" }
    elseif ($syncAllow.Count) { $syncArgs += @('--allow', ($syncAllow -join ',')) }
    $text = (& node @syncArgs 2>&1 | Out-String)
    $code = $LASTEXITCODE
    $key = "$code " + (($text -split "`r?`n" | Where-Object { $_ -match '^(IN SYNC|DELIVERED|REFUSED|FAILED|WAITING|CAPTURED|HELD BACK|SKIPPED|KNOWLEDGE|STOP)' }) -join ' | ')
    if ($key -ne $syncKey) {
      # Long enough for every held-back line and the ALLOW WITH line after them.
      # That line is file paths and line numbers only, and a long file name
      # masked by Redact could not be copied into autofix.liveSync.allow.
      $tail = (($text -split "`r?`n") | ForEach-Object { if ($_ -match '^ALLOW WITH: ([A-Za-z0-9_./-]+:\d+)?(,[A-Za-z0-9_./-]+:\d+)*$') { $_ } else { Redact $_ } } | Where-Object { $_.Trim() } | Select-Object -Last 200) -join "`n"
      $result = switch ($code) { 0 { '0 (in sync)' } 2 { '2 (needs a person)' } default { "$code (could not run)" } }
      [void]$ran.Add([ordered]@{ id = "auto-live-sync-$stamp"; do = 'live-sync (standing)'; result = $result; at = $started.ToString('s'); seconds = [int]((Get-Date) - $started).TotalSeconds; tail = $tail })
      Write-Host "live sync: $result"
    }
    $syncKey = $key
  }
}

# Deck liveness (Alpha's scripts\alpha_deck_liveness.py, which live sync
# delivers): every deck source judged by its own freshness field. Turned on by
# autofix.deckLiveness in actions.json; runs at most every everyMin minutes
# (default 15: reading the CrowPanel state costs the backend ~30 s) and is
# reported only when a deck's verdict changes. It runs with the Python the
# backend runs, because it signs in with the backend's own token signer.
$deckKey = if ($state -and $state.deckKey) { [string]$state.deckKey } else { '' }
$deckAt = if ($state -and $state.deckAt) { [string]$state.deckAt } else { '' }
$auditAt = if ($state -and $state.auditAt) { [string]$state.auditAt } else { '' }
$deck = if ($control -and $control.autofix -and $control.autofix.deckLiveness) { $control.autofix.deckLiveness } else { $null }
if ($deck -and (Test-Path -LiteralPath $AlphaRoot)) {
  $every = 15
  if ($deck -isnot [bool] -and $deck.everyMin) {
    $n = 0
    if ([int]::TryParse([string]$deck.everyMin, [ref]$n) -and $n -ge 5 -and $n -le 1440) { $every = $n } else { Write-Host 'autofix.deckLiveness.everyMin must be 5 to 1440: 15 used' }
  }
  $last = [datetime]::MinValue
  $due = -not $deckAt -or -not [datetime]::TryParse($deckAt, [ref]$last) -or ((Get-Date) - $last).TotalMinutes -ge $every
  if ($due) {
    $started = Get-Date
    $deckAt = $started.ToString('s')
    $deckScript = Join-Path (Join-Path (Split-Path -Parent $AlphaRoot) 'scripts') 'alpha_deck_liveness.py'
    $held = if (Get-Command Get-NetTCPConnection -EA SilentlyContinue) { Get-NetTCPConnection -LocalPort 8001 -State Listen -EA SilentlyContinue | Select-Object -First 1 }
    $py = if ($held) { (Get-Process -Id $held.OwningProcess -EA SilentlyContinue).Path }
    if (-not (Test-Path -LiteralPath $deckScript)) { $text = "STOP: $deckScript is not on this machine yet (live sync delivers it from the live branch)"; $code = 1 }
    elseif (-not $py) { $text = 'DECK DOWN: backend (/health) -> nothing listens on 8001  [decks: all decks]'; $code = 2 }
    else {
      $text = (& $py $deckScript --root (Split-Path -Parent $AlphaRoot) 2>&1 | Out-String)
      $code = $LASTEXITCODE
    }
    # The DECK lines carry verdicts, never ages, so a change is a real change.
    $key = "$code " + (($text -split "`r?`n" | Where-Object { $_ -match '^(DECK|STOP)' }) -join ' | ')
    if ($key -ne $deckKey) {
      $tail = (($text -split "`r?`n") | ForEach-Object { Redact $_ } | Where-Object { $_.Trim() } | Select-Object -Last 60) -join "`n"
      $result = switch ($code) { 0 { '0 (every deck live)' } 2 { '2 (not every deck is live)' } default { "$code (could not run)" } }
      [void]$ran.Add([ordered]@{ id = "auto-deck-liveness-$stamp"; do = 'deck-liveness (standing)'; result = $result; at = $started.ToString('s'); seconds = [int]((Get-Date) - $started).TotalSeconds; tail = $tail })
      Write-Host "deck liveness: $result"
    }
    $deckKey = $key
  }
}

# Channel watch (scripts/channel-watch.mjs): is every status channel named in
# autofix.channelWatch.channels ("name:minutes,...") still being written? Each
# report is written by the machine it is about, so a machine that stops also
# stops saying so: on 2026-10-07 Laptop41's autopilot went quiet at 23:24 UTC
# and a cloud session noticed three hours later. Reported only on a change.
$watchKey = if ($state -and $state.watchKey) { [string]$state.watchKey } else { '' }
$watch = if ($control -and $control.autofix -and $control.autofix.channelWatch -and $control.autofix.channelWatch.channels) { $control.autofix.channelWatch } else { $null }
if ($watch) {
  $channels = [string]$watch.channels
  if ($channels -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}:\d{1,4}(,[A-Za-z0-9][A-Za-z0-9._-]{0,63}:\d{1,4})*$') { Write-Host 'autofix.channelWatch.channels must be name:minutes,...: skipped' }
  else {
    $started = Get-Date
    $text = (& node (Join-Path $PSScriptRoot 'channel-watch.mjs') --repo $repo --channels $channels 2>&1 | Out-String)
    $code = $LASTEXITCODE
    $key = "$code " + (($text -split "`r?`n" | Where-Object { $_ -match '^(OK|SILENT|MISSING):' -or $_ -match '^could not run' }) -join ' | ')
    if ($key -ne $watchKey) {
      $tail = (($text -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -Last 20) -join "`n"
      $result = switch ($code) { 0 { '0 (every channel talking)' } 2 { '2 (a channel went quiet)' } default { "$code (could not run)" } }
      [void]$ran.Add([ordered]@{ id = "auto-channel-watch-$stamp"; do = 'channel-watch (standing)'; result = $result; at = $started.ToString('s'); seconds = [int]((Get-Date) - $started).TotalSeconds; tail = $tail })
      Write-Host "channel watch: $result"
    }
    $watchKey = $key
  }
}

# Alpha's own deck-by-deck check (backend deck_audit.py, every 30 min): each
# new report goes into this report, so the tunnel carries what Alpha found
# deck by deck and what she fixed. The owner, 2026-10-07: "teach alpha to do
# it, then report in the tunnel".
$auditFile = Join-Path (Join-Path (Split-Path -Parent $AlphaRoot) 'memory\local\deck-audit') 'latest.json'
if (Test-Path -LiteralPath $auditFile) {
  try {
    $audit = Get-Content -LiteralPath $auditFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $at = [string]$audit.checked_at
    if ($at -and $at -ne $auditAt) {
      $lines = @()
      foreach ($row in @($audit.decks)) {
        $held = @()
        if ($row.content -and $row.content.lists) { foreach ($p in $row.content.lists.PSObject.Properties) { if ($held.Count -lt 4) { $held += "$($p.Name) $($p.Value)" } } }
        $what = if ($held.Count) { $held -join ', ' } elseif ($row.content) { "$($row.content.keys) field(s)" } else { 'nothing read' }
        $fix = if (@($row.fixes).Count) { "  [$(@($row.fixes) -join '; ')]" } else { '' }
        $lines += ('{0,-7} {1}: {2} ({3}){4}' -f $row.verdict, $row.deck, $row.why, $what, $fix)
      }
      $c = $audit.counts
      $sum = "$([int]$c.WORKING) working, $([int]$c.EMPTY) empty, $([int]$c.BROKEN) broken"
      $tail = (@("DECK AUDIT by Alpha on $($audit.machine) at ${at}: $sum") + $lines | ForEach-Object { Redact $_ }) -join "`n"
      $res = if ([int]$c.BROKEN) { "2 ($sum)" } else { "0 ($sum)" }
      [void]$ran.Add([ordered]@{ id = "auto-deck-audit-$stamp"; do = 'deck-audit (Alpha)'; result = $res; at = (Get-Date).ToString('s'); seconds = 0; tail = $tail })
      Write-Host "deck audit (Alpha): $sum"
      $auditAt = $at
    }
  } catch { Write-Host "deck audit (Alpha): report unreadable ($($_.Exception.Message))" }
}

# Home Wi-Fi (autofix.homeWifi = {"ssid": "<the network the CrowPanel is on>"}).
# The owner, 2026-10-07: "make it automatic". That morning the home network
# blinked for a moment, Windows moved Worker1 to the router's other network
# and stayed there, and the panel, which is only on the home one, was dark all
# day. The other network stays as Windows' fallback on purpose: while the home
# one is down it is what keeps alpha-ai.uk online. So each pass:
# - off the home network while it is visible: rejoin it with the profile
#   Windows already saved, at most every 10 minutes. No passphrase is read or
#   written and no profile setting is changed;
# - on it, with the backend not listening on this address: restart the backend
#   as restart-backend does, at most every 30 minutes, when the address is in
#   its list; otherwise say to queue panel-host.
# Reported only when what it found changes, and whenever it acts.
# A stand-down queued in this pass has just written role.json: read it again,
# or the checks below treat the Alpha it stopped as one to restart.
$role = Read-Role
$standby = [bool]($role -and [string]$role.role -eq 'standby')
$wifiKey = if ($state -and $state.homeWifiKey) { [string]$state.homeWifiKey } else { '' }
$wifiJoinAt = if ($state -and $state.homeWifiJoinAt) { [string]$state.homeWifiJoinAt } else { '' }
$wifiRestartAt = if ($state -and $state.homeWifiRestartAt) { [string]$state.homeWifiRestartAt } else { '' }
$wifi = if ($control -and $control.autofix -and $control.autofix.homeWifi -and $control.autofix.homeWifi.ssid) { $control.autofix.homeWifi } else { $null }
if ($wifi) {
  $homeSsid = [string]$wifi.ssid
  $started = Get-Date
  $wlines = New-Object System.Collections.ArrayList
  $acted = $false
  try {
    $wa = Get-WifiAdapter
    if (-not $wa) { throw 'no Wi-Fi adapter answered' }
    $facts = Get-HomeWifiFacts $wa $homeSsid
    $do = Get-HomeWifiAction ($facts + @{ home = $homeSsid; now = $started; lastJoin = $wifiJoinAt; lastRestart = $wifiRestartAt; standby = $standby })
    [void]$wlines.Add($do.why)
    if ($do.action -eq 'rejoin') {
      $acted = $true
      $wifiJoinAt = (Get-Date).ToString('s')
      [void]$wlines.Add("rejoin: $(Join-HomeWifi $wa $homeSsid)")
      $facts = Get-HomeWifiFacts $wa $homeSsid
      $do = Get-HomeWifiAction ($facts + @{ home = $homeSsid; now = (Get-Date); lastJoin = $wifiJoinAt; lastRestart = $wifiRestartAt; standby = $standby })
      [void]$wlines.Add($do.why)
    }
    if ($do.action -eq 'restart') {
      $acted = $true
      $wifiRestartAt = (Get-Date).ToString('s')
      $r = Restart-Backend
      foreach ($l in ($r.text -split "`n")) { [void]$wlines.Add($l) }
      $facts = Get-HomeWifiFacts $wa $homeSsid
      $after = Get-HomeWifiAction ($facts + @{ home = $homeSsid; now = (Get-Date); lastJoin = $wifiJoinAt; lastRestart = $wifiRestartAt })
      [void]$wlines.Add("after: $($after.why)")
      $do = $after
    }
    $key = "$($facts.connected)|$($do.action)|$($do.why)"
  } catch {
    [void]$wlines.Add("could not check: $($_.Exception.Message)")
    $key = 'error'
  }
  if ($acted -or $key -ne $wifiKey) {
    $res = if ($key -eq 'error') { '1 (could not check)' } elseif ($do.action -eq 'report') { '2 (needs panel-host)' } elseif ($do.why -match 'listens on') { '0 (on the home network, backend reachable)' } else { "0 ($($do.action))" }
    [void]$ran.Add([ordered]@{ id = "auto-home-wifi-$stamp"; do = 'home-wifi (standing)'; result = $res; at = $started.ToString('s'); seconds = [int]((Get-Date) - $started).TotalSeconds; tail = (($wlines | ForEach-Object { Redact $_ }) -join "`n") })
    Write-Host "home wifi: $res"
  }
  $wifiKey = $key
}

# Phase 3's data (autofix.dataSync = {"peer": "<the other machine>",
# "everyMin": 10}): alpha-data-sync.ps1 sends what changed in memory\ while this
# machine serves Alpha, and applies what the peer sent while it does not. Run as
# a child with a time limit, so a large copy cannot hold the pass; reported when
# it sent, applied, held or failed, or when that changes.
$dsKey = if ($state -and $state.dataSyncKey) { [string]$state.dataSyncKey } else { '' }
$dsAt = if ($state -and $state.dataSyncAt) { [string]$state.dataSyncAt } else { '' }
$ds = if ($control -and $control.autofix -and $control.autofix.dataSync -and $control.autofix.dataSync.peer) { $control.autofix.dataSync } else { $null }
if ($ds) {
  $every = 10
  if ($ds.everyMin -and [int]$ds.everyMin -ge 5) { $every = [int]$ds.everyMin }
  $lastDs = [datetime]::MinValue
  [void][datetime]::TryParse($dsAt, [ref]$lastDs)
  if (((Get-Date) - $lastDs).TotalMinutes -ge $every) {
    $started = Get-Date
    $dsAt = $started.ToString('s')
    $dsOut = ''; $dsCode = 1
    if ([string]$ds.peer -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,62}$') { $dsOut = 'REFUSED: autofix.dataSync.peer must be a machine name' }
    else {
      $dsLog = Join-Path $dir "$stamp-data-sync.log"
      try {
        $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $PSScriptRoot 'alpha-data-sync.ps1')`"", '-OpsDir', "`"$OpsDir`"", '-AlphaRoot', "`"$AlphaRoot`"", '-Peer', [string]$ds.peer, '-MaxBytes', '104857600') `
                  -WorkingDirectory $repo -NoNewWindow -PassThru -RedirectStandardOutput $dsLog -RedirectStandardError "$dsLog.err"
        $null = $proc.Handle
        if ($proc.WaitForExit(15 * 60000)) { $dsCode = $proc.ExitCode } else { Stop-Process -Id $proc.Id -Force -EA SilentlyContinue; $dsCode = 'timeout after 15 min' }
        $dsOut = ((Get-Content -LiteralPath $dsLog, "$dsLog.err" -EA SilentlyContinue) -join "`n").Trim()
      } catch { $dsOut = "could not start: $($_.Exception.Message)" }
    }
    $acted = $dsOut -match '(?m)^\s*(SENT|APPLIED|HELD|REFUSED|NOT SENT|FAILED)'
    $k = "$dsCode|" + ((@($dsOut -split "`n" | Where-Object { $_ -match '^\s*(HELD|REFUSED|NOT SENT|FAILED|PART|waiting|taildrop)' }) | ForEach-Object { ($_.Trim() -replace '[\d.,]+ (MB|file)', '# $1') }) -join '|')
    if ($acted -or $k -ne $dsKey) {
      $res = if ("$dsCode" -eq '0') { '0 (in step)' } elseif ("$dsCode" -eq '3') { '3 (held, or still arriving)' } else { "$dsCode (failed)" }
      [void]$ran.Add([ordered]@{ id = "auto-data-sync-$stamp"; do = 'data-sync (standing)'; result = $res; at = $started.ToString('s'); seconds = [int]((Get-Date) - $started).TotalSeconds; tail = (Redact $dsOut) })
      Write-Host "data sync: $res"
    }
    $dsKey = $k
  }
}

$history = @()
if ($state -and $state.history) { $history = @($state.history) }
$history = @(@($ran) + $pending + $history | Select-Object -First 20)
$ran = @(@($ran) + $pending)
$noteChanged = -not $state -or [string]$state.checkoutNote -ne $checkoutNote
@{ done = $done; history = $history; lastRun = (Get-Date).ToString('s'); checkoutNote = $checkoutNote; brainKey = $brainKey; syncKey = $syncKey; deckKey = $deckKey; deckAt = $deckAt; auditAt = $auditAt; watchKey = $watchKey; homeWifiKey = $wifiKey; homeWifiJoinAt = $wifiJoinAt; homeWifiRestartAt = $wifiRestartAt; dataSyncKey = $dsKey; dataSyncAt = $dsAt; pending = @() } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding UTF8
# 3c. The live report (autofix.heartbeat): every pass, whatever else did or
# did not happen, one short page on status/<channel>-live says whether Alpha is
# live. The owner asked for a report every 5 minutes, and a report written only
# on change cannot tell "nothing changed" from "the reporter died".
# - Alpha: self-heal's own last probes (backend, site, alpha-ai.uk), which run
#   every 2 minutes; nothing is probed twice.
# - The repair agent: if self-heal has not written its log for 6 minutes, its
#   task is started again, at most once every 30 minutes. It is never
#   duplicated here: two repairers would fight over the same processes.
# - Decks: the deck check's last receipt. Live sync: its last state.
function Read-SelfHeal {
  $log = Join-Path $OpsDir 'logs\selfheal.jsonl'
  if (-not (Test-Path -LiteralPath $log)) { return $null }
  $age = [int]((Get-Date) - (Get-Item -LiteralPath $log).LastWriteTime).TotalMinutes
  $last = $null
  try { $last = (Get-Content -LiteralPath $log -Tail 1 -EA Stop) | ConvertFrom-Json } catch { }
  return [pscustomobject]@{ age = $age; last = $last }
}
# Why self-heal's log went quiet, from what it leaves on disk (alpha-selfheal.mjs):
# a config it cannot read (selfheal.json.error.json, newer than the log) or a
# pass holding its lock. "STOPPED" alone sent a person to Task Scheduler.
function SelfHeal-WhyQuiet {
  $log = Join-Path $OpsDir 'logs\selfheal.jsonl'
  $logAt = if (Test-Path -LiteralPath $log) { (Get-Item -LiteralPath $log).LastWriteTime } else { [datetime]::MinValue }
  $cfgErr = Join-Path $OpsDir 'selfheal.json.error.json'
  if ((Test-Path -LiteralPath $cfgErr) -and (Get-Item -LiteralPath $cfgErr).LastWriteTime -gt $logAt) {
    $e = try { (Get-Content -LiteralPath $cfgErr -Raw | ConvertFrom-Json).error } catch { 'unreadable' }
    return "it cannot read selfheal.json ($e): run scripts\repair-alpha-host.ps1, which rewrites it"
  }
  $stateDir = try { [string]((Get-Content -LiteralPath (Join-Path $OpsDir 'selfheal.json') -Raw) -replace '^\uFEFF', '' | ConvertFrom-Json).stateDir } catch { '' }
  if (-not $stateDir) { $stateDir = Join-Path $OpsDir 'selfheal' }
  $lock = Join-Path $stateDir 'selfheal.lock'
  if (Test-Path -LiteralPath $lock) {
    $mins = [int]((Get-Date) - (Get-Item -LiteralPath $lock).LastWriteTime).TotalMinutes
    $holderPid = try { [int](Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json).pid } catch { 0 }
    $alive = $holderPid -and (Get-Process -Id $holderPid -EA SilentlyContinue)
    return "a pass has held its lock for $mins min (pid $(if ($holderPid) { $holderPid } else { '?' }), $(if ($alive) { 'still running' } else { 'gone' }))"
  }
  return ''
}
function Publish-Live([string]$md, [string]$json, [string]$headline) {
  $liveBranch = "status/$Channel-live"
  $tmpRoot = Join-Path $OpsDir 'tmp'
  New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null
  $lwt = Join-Path $tmpRoot "live-$stamp"
  git -C $repo fetch -q origin $liveBranch 2>&1 | Out-Null
  $lbase = if ($LASTEXITCODE -eq 0) { 'FETCH_HEAD' } else { 'HEAD' }
  git -C $repo worktree add --detach $lwt $lbase 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Host 'live report: could not create a worktree'; return }
  New-Item -ItemType Directory -Force -Path (Join-Path $lwt 'reports') | Out-Null
  Set-Content -LiteralPath (Join-Path $lwt 'reports\live.md') -Value $md -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $lwt 'reports\live.json') -Value $json -Encoding UTF8
  git -C $lwt add reports 2>&1 | Out-Null
  git -C $lwt -c "user.name=$Channel-autopilot" -c "user.email=autopilot@$($Channel).invalid" commit -q -m "$Channel live ${stamp}: $headline" 2>&1 | Out-Null
  git -C $lwt push -q origin "HEAD:refs/heads/$liveBranch" 2>&1 | Out-Null
  $ok = ($LASTEXITCODE -eq 0)
  git -C $repo worktree remove --force $lwt 2>&1 | Out-Null
  Write-Host $(if ($ok) { "live report: $headline" } else { 'live report: push failed' })
}
if ($control -and $control.autofix -and $control.autofix.heartbeat) {
  $now = Get-Date
  $sh = Read-SelfHeal
  $alpha = [ordered]@{ verdict = 'UNKNOWN'; detail = ''; checked_by = '' }
  $heal = [ordered]@{ state = 'NOT INSTALLED'; age_min = $null; repairs = 0; restarted = ''; snapshot = ''; unfinished = ''; why = '' }
  if ($sh) {
    $heal.age_min = $sh.age
    # A snapshot is self-heal saving the site's last good build for rollback,
    # not a repair; a failed one is worth saying, as its own note.
    $heal.repairs = @($sh.last.actions | Where-Object { $_ -and $_.action -ne 'snapshot' }).Count
    $badSnap = @($sh.last.actions | Where-Object { $_ -and $_.action -eq 'snapshot' -and $_.code -ne 0 }) | Select-Object -First 1
    if ($badSnap) { $heal.snapshot = 'the rollback copy of the site was not saved' + $(if ($badSnap.error) { ": $(Redact ([string]$badSnap.error))" } else { ' (no reason logged)' }) }
    $heal.state = if ($sh.age -le 6) { 'RUNNING' } else { 'STOPPED' }
    # A pass that could not finish still writes its line, saying where it stopped.
    if ($sh.last -and $sh.last.unfinished) { $heal.unfinished = "the last pass did not finish ($($sh.last.unfinished.why), at $($sh.last.unfinished.stage))" }
    if ($heal.state -eq 'STOPPED') { $heal.why = SelfHeal-WhyQuiet }
  }
  if ($heal.state -eq 'RUNNING' -and $sh.last -and $sh.last.probes) {
    $parts = [ordered]@{ backend = $sh.last.probes.backend; site = $sh.last.probes.frontend; 'alpha-ai.uk' = $sh.last.probes.public }
    $down = @($parts.Keys | Where-Object { -not ($parts[$_] -and $parts[$_].ok -eq $true) })
    $alpha.verdict = if ($down.Count) { 'DOWN' } else { 'LIVE' }
    $alpha.detail = (($parts.Keys | ForEach-Object { "$_ $(if ($parts[$_]) { $parts[$_].status } else { '?' })" }) -join ', ') + $(if ($down.Count) { "; not answering: $($down -join ', ')" } else { '' })
    $alpha.checked_by = "self-heal, $($sh.age) min ago"
  } else {
    # Self-heal is not watching, so look at the backend directly (only that).
    $code = $null
    try { $code = [int](Invoke-WebRequest -Uri 'http://127.0.0.1:8001/health' -UseBasicParsing -TimeoutSec 8).StatusCode } catch { $code = $null }
    $alpha.verdict = if ($code -eq 200) { 'BACKEND UP' } else { 'DOWN' }
    $alpha.detail = "backend $(if ($code) { $code } else { 'no answer' }); site and alpha-ai.uk unchecked while self-heal is $(if ($heal.state -eq 'RUNNING') { 'not finishing its passes' } else { 'not running' })"
    $alpha.checked_by = 'this pass'
  }
  # A standby serves nothing here, on purpose: say who does, and say loudly if
  # anything here is serving too, since two Alphas write two histories.
  if ($standby) {
    $here = @()
    try { if (Get-NetTCPConnection -LocalPort 8001 -State Listen -EA Stop) { $here += 'backend' } } catch { }
    try { if (Get-NetTCPConnection -LocalPort 4173 -State Listen -EA Stop) { $here += 'site' } } catch { }
    if (Get-Process -Name cloudflared -EA SilentlyContinue) { $here += 'connector' }
    $pub = 0
    try { $pub = [int](Invoke-WebRequest -Uri 'https://alpha-ai.uk/' -UseBasicParsing -TimeoutSec 10 -EA Stop).StatusCode } catch { $r = $_.Exception.Response; if ($r -and $r.StatusCode) { $pub = [int]$r.StatusCode } }
    $alpha.verdict = if ($here.Count) { 'STANDBY BUT SERVING' } else { 'STANDBY' }
    $alpha.detail = "Alpha serves from $($role.primary): alpha-ai.uk $(if ($pub) { $pub } else { 'no answer' }); " +
      $(if ($here.Count) { "running HERE too: $($here -join ', ') (two Alphas: queue alpha-standdown again, or alpha-standup to serve here)" } else { 'nothing of Alpha runs here' })
    $alpha.checked_by = 'this pass'
    $heal.state = 'OFF (standby)'; $heal.why = ''; $heal.unfinished = ''
  }
  if ($heal.state -eq 'STOPPED') {
    $kickFile = Join-Path $dir 'selfheal-restart.txt'
    $lastKick = [datetime]::MinValue
    if (Test-Path -LiteralPath $kickFile) { [void][datetime]::TryParse((Get-Content -LiteralPath $kickFile -Raw).Trim(), [ref]$lastKick) }
    if (($now - $lastKick).TotalMinutes -ge 30) {
      Set-Content -LiteralPath $kickFile -Value $now.ToString('s')
      try { Start-ScheduledTask -TaskName 'Alpha Self-Heal' -EA Stop; $heal.restarted = 'started its task again' }
      catch {
        & schtasks.exe /Run /TN 'Alpha Self-Heal' 2>&1 | Out-Null
        $heal.restarted = $(if ($LASTEXITCODE -eq 0) { 'started its task again (schtasks)' } else { 'could not start its task: run scripts\repair-alpha-host.ps1 as Administrator' })
      }
    } else { $heal.restarted = "restart already tried at $($lastKick.ToString('HH:mm'))" }
  }
  # Which machine this is, and whether automatic cover (alpha-standby.mjs,
  # Phase 3) is watching: a standby whose pass stopped will not cover.
  $roleName = if ($role -and $role.role) { [string]$role.role } else { 'primary' }
  $cover = [ordered]@{ role = $roleName.ToUpper(); detail = '' }
  $coverFile = Join-Path $OpsDir 'standby\status.json'
  $coverPass = $null
  if (Test-Path -LiteralPath $coverFile) { try { $coverPass = Get-Content -LiteralPath $coverFile -Raw | ConvertFrom-Json } catch { } }
  $coverAge = if ($coverPass) { [int]((Get-Date) - (Get-Item -LiteralPath $coverFile).LastWriteTime).TotalMinutes } else { $null }
  # PowerShell 7 reads an ISO date in JSON as a date; 5.1 leaves it text.
  $since = Iso-Text $role.since
  if ($roleName -eq 'covering') { $cover.detail = "this machine serves Alpha for $($role.primary)$(if ($since) { " since $since" })" }
  elseif ($roleName -eq 'standby') { $cover.detail = "$($role.primary) serves Alpha" }
  else { $cover.detail = 'this machine serves Alpha' }
  if ($null -eq $coverAge) { $cover.detail += $(if ($roleName -eq 'primary') { '; automatic cover is not installed here' } else { '; automatic cover is NOT INSTALLED: queue standby-install' }) }
  elseif ($coverAge -gt 5 -and $roleName -ne 'primary') { $cover.detail += "; automatic cover is NOT RUNNING (last pass $coverAge min ago)" }
  elseif ($roleName -ne 'primary') { $cover.detail += "; automatic cover: $($coverPass.why) ($coverAge min ago)" }
  else { $cover.detail += '; automatic cover installed, idle while this machine is the primary' }
  # Phase 3's data: when this machine last sent its changes, applied the
  # peer's, and what waits for data-apply.
  $data = [ordered]@{ state = 'OFF'; detail = 'no data copy here (autofix.dataSync)' }
  $dsState = $null
  $dsFile = Join-Path $OpsDir 'data-sync\state.json'
  if (Test-Path -LiteralPath $dsFile) { try { $dsState = Get-Content -LiteralPath $dsFile -Raw | ConvertFrom-Json } catch { } }
  if ($dsState) {
    $parts = @()
    if ($dsState.lastSend) { $parts += "sent $($dsState.lastSend.files) file(s) to $($dsState.lastSend.to) at $(Iso-Text $dsState.lastSend.at)$(if ([int64]$dsState.lastSend.leftBytes) { " ($([math]::Round([int64]$dsState.lastSend.leftBytes / 1MB)) MB still to send)" })" }
    if ($dsState.lastApply) { $parts += "applied $($dsState.lastApply.files) from $($dsState.lastApply.from) at $(Iso-Text $dsState.lastApply.at)$(if ([int]$dsState.lastApply.keptNewerHere) { " ($($dsState.lastApply.keptNewerHere) newer here kept)" })" }
    if ([int]$dsState.held) { $parts += "$($dsState.held) package(s) HELD: queue data-apply" }
    $data.state = if ([int]$dsState.held) { 'HELD' } else { 'ON' }
    $data.detail = if ($parts.Count) { $parts -join '; ' } else { 'baseline set; nothing sent or applied yet' }
  } elseif ($ds) { $data.state = 'ON'; $data.detail = "copying with $($ds.peer); no pass yet" }
  $decks = [ordered]@{ summary = 'not checked yet'; not_live = @(); checked_at = $null }
  $receipt = Join-Path (Join-Path (Split-Path -Parent $AlphaRoot) 'memory\local\deck-liveness') 'latest.json'
  if (Test-Path -LiteralPath $receipt) {
    try {
      $r = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
      # One count per deck, not per check: the CrowPanel has two checks (its
      # feed and whether a panel reads it) and was counted as two decks. A deck
      # takes its worst verdict; its checks are named under it when not live.
      $rank = @{ 'DOWN' = 0; 'ERROR' = 1; 'SETTING' = 2; 'PLACEHOLDER' = 3; 'STALE' = 4; 'DEGRADED' = 5 }
      $groups = @($r.sources | Group-Object { if ($_.decks) { [string]$_.decks } else { [string]$_.source } })
      $verdicts = @(); $notLive = @()
      foreach ($g in $groups) {
        $bad = @($g.Group | Where-Object { $rank.ContainsKey([string]$_.verdict) } | Sort-Object { $rank[[string]$_.verdict] })
        if ($bad.Count) {
          $verdicts += [string]$bad[0].verdict
          $parts = @($bad | ForEach-Object { $n = [string]$_.source; if ($g.Name -and $n.StartsWith("$($g.Name) ")) { $n.Substring($g.Name.Length + 1) } else { $n } })
          $notLive += $(if ($g.Group.Count -gt 1 -or $parts[0] -ne $g.Name) { "$($g.Name): $($parts -join ', ')" } else { $g.Name })
        } else { $verdicts += [string]$g.Group[0].verdict }
      }
      $counts = @($verdicts | Group-Object | ForEach-Object { "$($_.Count) $($_.Name.ToLower())" })
      $decks.summary = $counts -join ', '
      $decks.not_live = $(if ($r.sources) { $notLive } else { @($r.not_live) })
      $decks.checked_at = [string]$r.checked_at
    } catch { $decks.summary = 'receipt unreadable' }
  }
  $syncState = (($syncKey -replace '^\d+ ', '') -split ' \| ' | Where-Object { $_ -match '^(IN SYNC|DELIVERED|REFUSED|FAILED|WAITING|STOP)' } | Select-Object -First 1)
  if (-not $syncState) { $syncState = $(if ($sync) { 'no state yet' } else { 'off' }) }
  $syncState = Redact $syncState
  $headline = "Alpha $($alpha.verdict); self-heal $($heal.state)"
  $md = @(
    "# Alpha is $($alpha.verdict) - $env:COMPUTERNAME, $($now.ToString('yyyy-MM-dd HH:mm zzz'))", '',
    'Written every autopilot pass (5 minutes), whether or not anything changed.', '',
    '| Check | State | Detail |', '|---|---|---|',
    "| Alpha (backend, site, alpha-ai.uk) | $($alpha.verdict) | $($alpha.detail) (checked by $($alpha.checked_by)) |",
    "| Role | $($cover.role) | $(Redact $cover.detail) |",
    "| Data copy | $($data.state) | $(Redact $data.detail) |",
    "| Repair agent (self-heal) | $($heal.state) | $(if ($standby) { 'off on purpose: another machine serves Alpha' } elseif ($null -ne $heal.age_min) { "last pass $($heal.age_min) min ago, $($heal.repairs) repair(s) in it" } else { 'no log: run scripts\repair-alpha-host.ps1' })$(if ($heal.unfinished) { "; $($heal.unfinished)" })$(if ($heal.why) { "; $($heal.why)" })$(if ($heal.snapshot) { "; $($heal.snapshot)" })$(if ($heal.restarted) { "; $($heal.restarted)" }) |",
    "| Decks | $($decks.summary) | $(if ($decks.not_live.Count) { 'not live: ' + ($decks.not_live -join '; ') } else { 'all data decks live' })$(if ($decks.checked_at) { " (checked $($decks.checked_at))" }) |",
    "| Live sync | $(($syncState -split ':')[0]) | $syncState |", ''
  ) -join "`n"
  $json = [ordered]@{ at = $now.ToString('o'); machine = $env:COMPUTERNAME; alpha = $alpha; role = $cover; data = $data; selfheal = $heal; decks = $decks; sync = $syncState } | ConvertTo-Json -Depth 5
  Publish-Live $md $json $headline
}

if (-not $ran.Count -and -not ($noteChanged -and $updateExit -ne 0)) { Write-Host 'nothing new to run'; exit 0 }

# 4. Report, from a temporary worktree so this checkout is never switched or dirtied.
$branch = "status/$Channel-autopilot"
$body = @("# $Channel autopilot $stamp", '', "Host: $env:COMPUTERNAME   Alpha: $AlphaRoot", '', (Redact $checkoutNote), '')
foreach ($h in $history) {
  $body += "## $($h.id)  $($h.do)  ->  $($h.result)   ($($h.at), $($h.seconds)s)"
  $body += '```'; $body += $h.tail; $body += '```'; $body += ''
}
$tmp = Join-Path $OpsDir 'tmp'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$wt = Join-Path $tmp "autopilot-$stamp"
git -C $repo fetch -q origin $branch 2>&1 | Out-Null
$base = if ($LASTEXITCODE -eq 0) { 'FETCH_HEAD' } else { 'HEAD' }
git -C $repo worktree add --detach $wt $base 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host 'could not create a worktree; report kept in state.json' -ForegroundColor Yellow; exit 1 }
New-Item -ItemType Directory -Force -Path (Join-Path $wt 'reports') | Out-Null
Set-Content -LiteralPath (Join-Path $wt 'reports\autopilot.md') -Value ($body -join "`n") -Encoding UTF8
git -C $wt add reports 2>&1 | Out-Null
$summary = $(if ($ran.Count) { ($ran | ForEach-Object { "$($_.id)=$($_.result)" }) -join ' ' } else { 'checkout cannot update' })
git -C $wt -c "user.name=$Channel-autopilot" -c "user.email=autopilot@$($Channel).invalid" commit -q -m "$Channel autopilot ${stamp}: $summary" 2>&1 | Out-Null
git -C $wt push -q origin "HEAD:refs/heads/$branch" 2>&1 | Out-Null
$pushed = ($LASTEXITCODE -eq 0)
git -C $repo worktree remove --force $wt 2>&1 | Out-Null
Write-Host $(if ($pushed) { "reported to $branch" } else { 'push failed; report kept in state.json' })
exit 0

<#
  fix-3d.ps1 — find out why Alpha is not rendering 3D on this machine.

  Run on the machine whose browser shows the blank panel:
      powershell -ExecutionPolicy Bypass -File .\fix-3d.ps1

  This script CHANGES NOTHING. It only reads, and every check prints its own
  fix, because the output has to be read on the machine — it cannot be relied
  on to travel back to whoever is helping.

  Alpha has three 3D surfaces, and which of them are blank is the first thing
  that narrows the cause:

    the avatar in the top bar   AvatarCoreRenderer, mounted on every tab
    the "Avatar Lab" tab        AvatarLabPanel
    the "3D Ops" tab            UnifiedOps3DPanel

  If the top-bar avatar draws but "3D Ops" is blank, the GPU and the browser
  are fine and the fault is in that panel or the files it loads — skip to the
  PACKAGES and ASSETS sections. If nothing anywhere draws, it is the browser
  or the driver — the GPU and WEBGL sections are the ones that matter.

  Two files are written next to this script:
    fix-3d-log.txt     everything printed here, so you can attach it
    webgl-check.html   open it in the SAME browser you use for Alpha; it is
                       the only check that can see what the browser actually
                       gives the page, which is the decisive question
#>

param(
  [string]$AlphaRoot = 'C:\AlphaData\Alpha',
  [string]$Url = ''
)

$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'fix-3d-log.txt'
Start-Transcript -Path $log -Force | Out-Null

function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function OK($t)      { Write-Host "  ok: $t" -ForegroundColor Green }
function Warn($t)    { Write-Host "  $t" -ForegroundColor Yellow }
function Bad($t)     { Write-Host "  $t" -ForegroundColor Red }
function Fix($t)     { Write-Host "     fix: $t" -ForegroundColor Magenta }

# ------------------------------------------------------------- Alpha root
Section "Alpha on disk"
if (-not (Test-Path $AlphaRoot)) {
  Bad "$AlphaRoot does not exist."
  Fix "Re-run with the real path: .\fix-3d.ps1 -AlphaRoot <path-to-Alpha>"
  Fix "Find it with: Get-ChildItem C:\ -Recurse -Filter AppShell.tsx -EA SilentlyContinue | Select -First 1"
  Write-Host "`nFull log written to: $log`n"
  Stop-Transcript | Out-Null
  exit 1
}
OK $AlphaRoot

$pkgDirs = @()
foreach ($rel in @('', 'frontend')) {
  $d = if ($rel) { Join-Path $AlphaRoot $rel } else { $AlphaRoot }
  if (Test-Path (Join-Path $d 'package.json')) { $pkgDirs += $d }
}
if (-not $pkgDirs) { Warn "No package.json under $AlphaRoot — the PACKAGES section below cannot run." }

# --------------------------------------------------------------- packages
# A 3D panel whose library is missing does not warn, it throws on import and
# React renders nothing where the canvas should be. This is the most likely
# cause right after a code copy: sync-alpha.ps1 deliberately does not copy
# node_modules, so a refresh that skipped its rebuild leaves exactly this.
Section "3D packages: declared vs installed"
$known3d = @(
  'three', '@react-three/fiber', '@react-three/drei', '@react-three/postprocessing',
  'babylonjs', '@babylonjs/core', '@babylonjs/loaders',
  'troika-three-text', 'three-stdlib', 'camera-controls',
  'globe.gl', 'three-globe', 'cesium', 'resium', 'deck.gl', '@deck.gl/core',
  'maplibre-gl', 'mapbox-gl', 'ogl', 'regl', 'gl-matrix'
)
$missing = @()
$found3d = $false
foreach ($d in $pkgDirs) {
  $pkg = Get-Content (Join-Path $d 'package.json') -Raw | ConvertFrom-Json
  $deps = @{}
  foreach ($set in @($pkg.dependencies, $pkg.devDependencies)) {
    if ($set) { $set.PSObject.Properties | ForEach-Object { $deps[$_.Name] = $_.Value } }
  }
  $mine = $known3d | Where-Object { $deps.ContainsKey($_) }
  if (-not $mine) { continue }
  $found3d = $true
  Write-Host "  in $d"
  foreach ($name in $mine) {
    $path = Join-Path $d "node_modules\$name"
    if (Test-Path $path) {
      $v = try { (Get-Content (Join-Path $path 'package.json') -Raw | ConvertFrom-Json).version } catch { '?' }
      OK "$name $v  (declared $($deps[$name]))"
    } else {
      Bad "$name declared as $($deps[$name]) but NOT in node_modules"
      $missing += [pscustomobject]@{ Dir = $d; Name = $name }
    }
  }
}
if (-not $found3d) {
  Warn "No known 3D library is declared in any package.json here."
  Warn "Either the 3D panels use something this script does not know about, or"
  Warn "they were never wired to a renderer on this machine. Send me the"
  Warn "dependencies block of $($pkgDirs -join ' and ')."
}
if ($missing) {
  Bad "$($missing.Count) 3D package(s) declared but not installed. A panel importing one of these renders nothing."
  foreach ($d in ($missing.Dir | Select-Object -Unique)) { Fix "cd `"$d`"  then  npm install" }
  Fix "Then rebuild: npm run build (if this machine serves a built copy rather than a dev server)"
}

# ----------------------------------------------------------------- assets
# A 3D panel with no model to load draws an empty scene, which looks exactly
# like a broken renderer.
Section "3D asset files on disk"
$exts = @('*.glb','*.gltf','*.fbx','*.obj','*.stl','*.ply','*.usdz','*.hdr','*.exr','*.ktx2','*.basis','*.bin','*.drc')
$assets = @(Get-ChildItem $AlphaRoot -Recurse -File -Include $exts -EA SilentlyContinue |
            Where-Object { $_.FullName -notmatch '\\node_modules\\' })
if (-not $assets) {
  Warn "No model, texture or environment files found anywhere under $AlphaRoot."
  Warn "If the 3D panels build their geometry in code this is normal. If they"
  Warn "are supposed to load a model, this is the whole problem — the files"
  Warn "were never copied here."
  Fix "On the host: Get-ChildItem C:\AlphaData\Alpha -Recurse -Include *.glb,*.gltf | Measure-Object"
  Fix "If the host has them and this machine does not, re-run sync-alpha.ps1 -Mode Send from the host."
} else {
  $byExt = $assets | Group-Object Extension | Sort-Object Count -Descending
  foreach ($g in $byExt) { Write-Host ("  {0,-8} {1}" -f $g.Name, $g.Count) }
  OK "$($assets.Count) asset file(s), $([math]::Round(($assets | Measure-Object Length -Sum).Sum/1MB,1)) MB total"
  Write-Host "  largest:"
  $assets | Sort-Object Length -Descending | Select-Object -First 5 |
    ForEach-Object { Write-Host ("    {0,8:N1} MB  {1}" -f ($_.Length/1MB), $_.FullName.Replace($AlphaRoot,'')) }
  $zero = @($assets | Where-Object Length -eq 0)
  if ($zero) {
    Bad "$($zero.Count) asset file(s) are 0 bytes — a truncated or failed copy."
    $zero | ForEach-Object { Write-Host "    $($_.FullName)" }
    Fix "Re-copy Alpha with sync-alpha.ps1, or restore those files from the host."
  }
}

# ---------------------------------------------------------------- serving
# Find where Alpha is actually listening rather than guessing a port.
Section "Where Alpha is listening"
$urls = @()
if ($Url) {
  $urls += $Url.TrimEnd('/')
  OK "using -Url $Url"
} else {
  $listeners = @(Get-NetTCPConnection -State Listen -EA SilentlyContinue |
    Where-Object { $_.LocalAddress -in @('0.0.0.0','127.0.0.1','::','::1') } |
    Select-Object LocalPort, OwningProcess -Unique)
  $web = @()
  foreach ($l in $listeners) {
    $p = Get-Process -Id $l.OwningProcess -EA SilentlyContinue
    if ($p -and $p.ProcessName -match 'node|python|nginx|caddy|httpd|deno|bun') {
      $web += [pscustomobject]@{ Port = $l.LocalPort; Process = $p.ProcessName }
    }
  }
  if (-not $web) {
    Warn "No node/python/web-server process is listening. Alpha does not appear to be running here."
    Fix "Start Alpha the way this machine normally starts it, then re-run this script."
    Fix "Or point the check at wherever Alpha is served: .\fix-3d.ps1 -Url http://100.x.y.z:3000"
  } else {
    $web | Sort-Object Port | ForEach-Object { Write-Host ("  {0,-6} {1}" -f $_.Port, $_.Process) }
    foreach ($w in ($web | Sort-Object Port)) { $urls += "http://127.0.0.1:$($w.Port)" }
  }
}

# The check that catches the quiet one: a static server that answers every
# unknown path with index.html hands the loader HTML instead of a model. The
# request succeeds with 200, so nothing logs an error — the scene is just empty.
Section "Are 3D assets actually served?"
if (-not $urls) {
  Warn "Skipped: nothing to ask."
} else {
  # Public-dir assets are served from the web root, so build their URL paths.
  $publicAssets = @()
  foreach ($a in $assets) {
    if ($a.FullName -match '\\(public|static|assets|dist|build)\\') {
      $rel = $a.FullName -replace '^.*?\\(?:public|static|dist|build)\\', ''
      $publicAssets += '/' + ($rel -replace '\\', '/')
    }
  }
  $publicAssets = @($publicAssets | Select-Object -Unique | Select-Object -First 5)

  foreach ($u in $urls) {
    Write-Host "  $u"
    try {
      $r = Invoke-WebRequest $u -TimeoutSec 8 -UseBasicParsing
      Write-Host ("     / -> {0} {1}" -f $r.StatusCode, $r.Headers['Content-Type'])
    } catch {
      Warn "    / did not answer: $($_.Exception.Message)"
      continue
    }
    if (-not $publicAssets) {
      Warn "    No asset sits under a public/static/dist directory, so there is no URL to test."
      Warn "    If the panels import models through the bundler instead, that is expected."
      continue
    }
    foreach ($p in $publicAssets) {
      try {
        $r = Invoke-WebRequest ($u + $p) -TimeoutSec 15 -UseBasicParsing
        $ct = [string]$r.Headers['Content-Type']
        $len = $r.RawContentLength
        if ($ct -match 'text/html') {
          Bad "    $p -> $($r.StatusCode) but Content-Type is $ct"
          Bad "         The server answered with the app's HTML page, not the file."
          Bad "         A 3D loader receiving HTML fails with no visible error."
          Fix "Serve this directory as static files, or check the SPA fallback is not catching it."
        } elseif ($len -eq 0) {
          Bad "    $p -> $($r.StatusCode) but 0 bytes"
        } else {
          OK "    $p -> $($r.StatusCode) $ct  $([math]::Round($len/1KB,1)) KB"
        }
      } catch {
        Bad "    $p -> $($_.Exception.Message)"
        Fix "The panel cannot load this file. Confirm it exists under the directory the server publishes."
      }
    }
  }
}

# -------------------------------------------------------------------- GPU
Section "Graphics adapter and driver"
$vcs = @(Get-CimInstance Win32_VideoController -EA SilentlyContinue)
if (-not $vcs) {
  Warn "Could not read the video controller. Skipping."
} else {
  foreach ($v in $vcs) {
    Write-Host "  $($v.Name)"
    Write-Host "     driver $($v.DriverVersion)  ($($v.DriverDate))  status: $($v.Status)"
    if ($v.Name -match 'Microsoft Basic Display') {
      Bad "     This is Windows' fallback adapter — the real GPU driver is not loaded."
      Bad "     The browser will fall back to software WebGL, which renders 3D blank or at a few frames a second."
      Fix "Install the GPU vendor's driver for this laptop, then reboot and re-run."
    }
    if ($v.Status -and $v.Status -ne 'OK') {
      Bad "     Adapter status is '$($v.Status)', not OK."
      Fix "Check Device Manager > Display adapters for a warning triangle."
    }
  }
}

Section "Session type"
if ($env:SESSIONNAME -like 'RDP*') {
  Warn "This is a Remote Desktop session ($env:SESSIONNAME)."
  Warn "RDP gives the browser limited or no GPU access, so 3D can be blank here"
  Warn "while working fine on the physical screen."
  Fix "Test Alpha's 3D on the laptop's own screen before chasing anything else."
} else {
  OK "Console session (not RDP)."
}

# ------------------------------------------------------------------ WebGL
# PowerShell cannot see what the browser gives the page. This can.
Section "Browser check"
$probe = Join-Path $PSScriptRoot 'webgl-check.html'
$html = @'
<!doctype html>
<meta charset="utf-8">
<title>Alpha WebGL check</title>
<style>
  body { font: 14px/1.55 system-ui, sans-serif; margin: 0; padding: 24px;
         background: #0d1626; color: #e6edf7; }
  h1 { font-size: 1.15rem; margin: 0 0 4px; }
  p.sub { color: #8ea3c0; margin: 0 0 20px; }
  table { border-collapse: collapse; margin: 0 0 20px; }
  td { padding: 3px 16px 3px 0; vertical-align: top; }
  td:first-child { color: #8ea3c0; white-space: nowrap; }
  .ok { color: #56d364; } .bad { color: #ff7b72; } .warn { color: #e3b341; }
  #verdict { border-left: 3px solid #56d364; padding: 10px 14px; margin: 0 0 20px;
             background: #132033; white-space: pre-wrap; }
  #verdict.bad { border-left-color: #ff7b72; }
  #verdict.warn { border-left-color: #e3b341; }
  canvas { border: 1px solid #24364f; border-radius: 6px; display: block; }
  .hint { color: #8ea3c0; margin-top: 8px; }
</style>
<h1>Alpha WebGL check</h1>
<p class="sub">Open this in the same browser you use for Alpha. Nothing is sent anywhere.</p>
<div id="verdict">checking…</div>
<table id="facts"></table>
<canvas id="c" width="260" height="150"></canvas>
<p class="hint">A moving colour gradient above means the browser can draw with the GPU.
A blank or frozen box means it cannot, and no amount of fixing Alpha's code will help.</p>
<script>
(function () {
  var facts = document.getElementById('facts');
  var verdict = document.getElementById('verdict');
  function row(k, v, cls) {
    var tr = facts.insertRow();
    tr.insertCell().textContent = k;
    var td = tr.insertCell();
    td.textContent = v;
    if (cls) td.className = cls;
  }

  var canvas = document.getElementById('c');
  var gl = null, version = '';
  try { gl = canvas.getContext('webgl2'); if (gl) version = 'WebGL 2'; } catch (e) {}
  if (!gl) {
    try { gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
          if (gl) version = 'WebGL 1'; } catch (e) {}
  }

  if (!gl) {
    verdict.className = 'bad';
    verdict.textContent =
      'WebGL is NOT available in this browser.\n\n' +
      'Every 3D panel in Alpha will be blank, whatever the code does.\n\n' +
      'In order:\n' +
      '1. Open chrome://gpu (or edge://gpu) and read the "Graphics Feature Status" list.\n' +
      '2. Settings > System > turn ON "Use graphics acceleration when available", then restart the browser.\n' +
      '3. If it is still off, the GPU driver is the cause — see the adapter name printed by fix-3d.ps1.\n' +
      '4. On Remote Desktop, test on the laptop\u2019s own screen instead.';
    row('WebGL', 'unavailable', 'bad');
    return;
  }

  row('Context', version, 'ok');

  var renderer = 'unknown', vendor = 'unknown';
  var dbg = gl.getExtension('WEBGL_debug_renderer_info');
  if (dbg) {
    renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || 'unknown';
    vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || 'unknown';
  }
  var software = /swiftshader|software|llvmpipe|basic render/i.test(renderer);
  row('Renderer', renderer, software ? 'warn' : 'ok');
  row('Vendor', vendor);
  row('Max texture size', gl.getParameter(gl.MAX_TEXTURE_SIZE) + ' px');
  row('Max renderbuffer', gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) + ' px');
  row('Device pixel ratio', window.devicePixelRatio);
  row('Secure context', window.isSecureContext ? 'yes' : 'no (plain HTTP)',
      window.isSecureContext ? 'ok' : 'warn');
  row('User agent', navigator.userAgent);

  if (software) {
    verdict.className = 'warn';
    verdict.textContent =
      'WebGL works, but it is running in SOFTWARE (' + renderer + ').\n\n' +
      'The GPU is not being used. 3D will draw, but slowly enough to look broken,\n' +
      'and a heavy scene may never finish a frame.\n\n' +
      'Turn on graphics acceleration in the browser settings, and check the GPU\n' +
      'driver named by fix-3d.ps1. chrome://gpu says which of the two it is.';
  } else {
    verdict.className = '';
    verdict.textContent =
      'The browser can render 3D with the GPU (' + renderer + ').\n\n' +
      'So a blank 3D panel in Alpha is NOT the browser. Look at the panel and the\n' +
      'files it loads: the PACKAGES and ASSETS sections of fix-3d.ps1, and the\n' +
      'browser console (F12) on the "3D Ops" tab for a failed import or fetch.';
  }

  // Paint something, so "it works" is visible and not just asserted.
  var vs = 'attribute vec2 p; varying vec2 v; void main(){ v = p; gl_Position = vec4(p,0.0,1.0); }';
  var fs = 'precision mediump float; varying vec2 v; uniform float t;' +
           'void main(){ gl_FragColor = vec4(0.5+0.5*sin(t+v.x*3.0), 0.5+0.5*sin(t*1.3+v.y*3.0), 0.8, 1.0); }';
  function sh(type, src) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      row('Shader error', gl.getShaderInfoLog(s), 'bad');
      return null;
    }
    return s;
  }
  var a = sh(gl.VERTEX_SHADER, vs), b = sh(gl.FRAGMENT_SHADER, fs);
  if (!a || !b) return;
  var prog = gl.createProgram();
  gl.attachShader(prog, a); gl.attachShader(prog, b); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    row('Link error', gl.getProgramInfoLog(prog), 'bad');
    return;
  }
  gl.useProgram(prog);
  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  var tLoc = gl.getUniformLocation(prog, 't');
  var start = performance.now();
  (function frame() {
    gl.uniform1f(tLoc, (performance.now() - start) / 700);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(frame);
  })();
})();
</script>
'@
Set-Content -Path $probe -Value $html -Encoding UTF8
OK "wrote $probe"
Write-Host "  Open it in the SAME browser you use for Alpha:" -ForegroundColor Magenta
Write-Host "     start `"`" `"$probe`"" -ForegroundColor Magenta
Write-Host "  It reports whether the browser can use the GPU at all, which is the"
Write-Host "  one thing nothing on this side can determine."

Section "If 3D is still blank after all of the above"
Write-Host "  Open Alpha, go to the `"3D Ops`" tab, press F12, and read the Console tab."
Write-Host "  Send me the first red line. The three shapes it takes:"
Write-Host "    'Failed to resolve import' / 'does not provide an export'  -> a package is missing; see PACKAGES above"
Write-Host "    'Unexpected token <' or a JSON/GLB parse error             -> the server sent HTML; see SERVING above"
Write-Host "    'THREE.WebGLRenderer: Error creating WebGL context'        -> the browser or driver; see webgl-check.html"
Write-Host "  Also say which of the three surfaces are blank — the top-bar avatar,"
Write-Host "  `"Avatar Lab`", `"3D Ops`" — because that alone splits the causes in half."

Write-Host "`nFull log written to: $log`n"
Stop-Transcript | Out-Null

# Spike S3/S5 driver - Path A end-to-end: assembled Cesium GLSL -> glslang -> SPIR-V -> naga -> WGSL
#
# Toolchain (deliberately outside the repo, nothing installed at the repo root):
#   %TEMP%\shader-spike\glslang\bin\glslang.exe   glslang 16.6.0 (Khronos official Windows release)
#   %USERPROFILE%\.cargo\bin\naga.exe             naga-cli 30.0.1 (cargo install naga-cli --locked)
#
# Stages per case: (1) raw -> glslang -V  (2) glslang -E -> repair -> glslang -V -> naga -> WGSL
# Usage: pwsh -NoProfile -File run-path-a.ps1
$ErrorActionPreference = "Continue"
$tmp = "$env:TEMP\shader-spike"
$glslang = "$tmp\glslang\bin\glslang.exe"
$naga = "$env:USERPROFILE\.cargo\bin\naga.exe"
$spike = "E:\work\CesiumjsWebGpu\experiments\shader-spike"
$glsldir = "$spike\glsl"
$out = "$spike\logs"
$wgsl = "$spike\wgsl"
$pp = "$tmp\pp"
$work = "$tmp\work"
New-Item -ItemType Directory -Force -Path $out, $wgsl, $pp, $work | Out-Null

"glslang : $(& $glslang --version 2>&1 | Select-Object -First 1)"
"naga    : $(& $naga --version 2>&1 | Select-Object -First 1)"

function Invoke-Logged([string]$label, [string]$exe, [string[]]$argv, [string]$logName) {
  $o = & $exe @argv 2>&1
  $code = $LASTEXITCODE
  $o | Set-Content "$out\$logName" -Encoding utf8
  return @{ code = $code; text = ($o -join "`n") }
}

$cases = @(
  @{ n = "default-3d"; stage = "vert" },
  @{ n = "default-3d"; stage = "frag" },
  @{ n = "minimal-3d"; stage = "vert" },
  @{ n = "minimal-3d"; stage = "frag" },
  @{ n = "kitchen-sink"; stage = "vert" },
  @{ n = "kitchen-sink"; stage = "frag" }
)

$summary = @()
foreach ($c in $cases) {
  $file = "$($c.n).$($c.stage).glsl"
  "`n================ $file ================"

  # ---- Step 1: raw assembled GLSL straight into glslang (no repairs) -------------
  foreach ($flag in @("-V", "-G")) {
    $r = Invoke-Logged "$file$flag" $glslang @($flag, "$glsldir\$file", "-o", "$work\raw.spv") "raw-$($c.n).$($c.stage)$flag.glslang.txt"
    $first = ($r.text -split "`n" | Where-Object { $_ -match "ERROR" } | Select-Object -First 2) -join " | "
    "  [raw $flag] exit=$($r.code)  $first"
    $summary += [pscustomobject]@{ case = $c.n; stage = $c.stage; step = "raw-$flag"; exit = $r.code; spv = (Test-Path "$work\raw.spv"); wgsl = $false }
    Remove-Item "$work\raw.spv" -ErrorAction SilentlyContinue
  }

  # ---- Step 2: preprocess -> mechanical repair -> glslang -> naga ---------------
  & $glslang -E "$glsldir\$file" 2>&1 | Set-Content "$pp\$($c.n).$($c.stage).pp" -Encoding utf8
  $rep = "$pp\$($c.n).$($c.stage).repaired.$($c.stage).glsl"
  node "$spike\scripts\repair-preprocessed.mjs" "$pp\$($c.n).$($c.stage).pp" $c.stage $rep 2>&1 |
    Set-Content "$out\repair-$($c.n).$($c.stage).json" -Encoding utf8
  $repObj = Get-Content "$out\repair-$($c.n).$($c.stage).json" -Raw | ConvertFrom-Json
  $nUni = $repObj.repairs.uniformBlock.members
  $nLoc = $repObj.repairs.ioLocations.Count

  $spv = "$work\$($c.n).$($c.stage).spv"
  $r2 = Invoke-Logged "repaired" $glslang @("-V", $rep, "-o", $spv) "repaired-$($c.n).$($c.stage).glslang.txt"
  $spvOK = Test-Path $spv
  "  [repaired] uniforms->block=$nUni  io locations=$nLoc  glslang exit=$($r2.code)  spv=$spvOK ($(if($spvOK){(Get-Item $spv).Length}else{0}) bytes)"
  if (-not $spvOK) {
    ($r2.text -split "`n" | Where-Object { $_ -match "ERROR" } | Select-Object -First 3) | ForEach-Object { "      $_" }
  }
  $wgslOK = $false
  $wgslBytes = 0
  if ($spvOK) {
    $wgslFile = "$wgsl\$($c.n).$($c.stage).wgsl"
    $r3 = Invoke-Logged "naga" $naga @("--input-kind", "spv", $spv, $wgslFile) "repaired-$($c.n).$($c.stage).naga.txt"
    $wgslOK = Test-Path $wgslFile
    if ($wgslOK) { $wgslBytes = (Get-Item $wgslFile).Length }
    "  [naga   ] exit=$($r3.code)  wgsl=$wgslOK ($wgslBytes bytes)"
    if (-not $wgslOK) {
      ($r3.text -split "`n" | Select-Object -First 6) | ForEach-Object { "      $_" }
    }
  }
  $summary += [pscustomobject]@{ case = $c.n; stage = $c.stage; step = "repaired"; exit = $r2.code; spv = $spvOK; wgsl = $wgslOK }
}
$summary | Format-Table -AutoSize | Out-String -Width 200
$summary | ConvertTo-Json -Depth 4 | Set-Content "$out\path-a-summary.json" -Encoding utf8

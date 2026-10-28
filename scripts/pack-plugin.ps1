# 打包 E:\mesh\dsh-plugin-mesh 为 tarball，输出到 E:\mesh\dist\
param(
  [string]$PluginDir = 'E:\mesh\dsh-plugin-mesh',
  [string]$OutDir = 'E:\mesh\dist'
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutDir | Out-Null
Push-Location $PluginDir
try {
  # 确保 llms.txt 同步（基线拷贝缺 docs 目录时 check:docs 会失败；打包不依赖它）
  if (Test-Path '.\scripts\sync-llms.mjs') { node .\scripts\sync-llms.mjs --write 2>$null | Out-Null }
  Remove-Item "$OutDir\*.tgz" -ErrorAction SilentlyContinue
  $out = npm pack --pack-destination $OutDir 2>&1
  Write-Host $out
  $tgz = Get-ChildItem "$OutDir\*.tgz" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $tgz) { throw 'npm pack 没有产出 tarball' }
  Write-Host "PACKED: $($tgz.FullName) ($([math]::Round($tgz.Length/1KB)) KB)"
} finally { Pop-Location }

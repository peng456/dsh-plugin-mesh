# �?127.0.0.1:8792 起静态文件服务（供手机经 adb reverse 拉取�?$ErrorActionPreference = 'Stop'
$dist = 'E:\mesh\dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$py = 'C:\Python314\python.exe'
if (-not (Test-Path $py)) { $py = (Get-Command python -ErrorAction SilentlyContinue).Source }
if (-not $py) { throw '找不�?python' }
Write-Host "serving $dist on http://127.0.0.1:8792/ via $py"
& $py -m http.server 8792 --bind 127.0.0.1 --directory $dist


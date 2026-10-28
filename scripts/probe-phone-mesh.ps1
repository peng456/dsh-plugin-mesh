# 探测手机 dsh-go 内 mesh 健康状态（经 adb forward）
param([string]$Serial = '1441e87a', [int]$Port = 45917)
$adb = 'E:\AndroidSDK\platform-tools\adb.exe'
& $adb -s $Serial forward "tcp:$Port" "tcp:$Port" | Out-Null
function Get-Json($path) {
  try { (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port$path" -TimeoutSec 6).Content | ConvertFrom-Json }
  catch { Write-Host "ERR $path : $($_.Exception.Message)"; $null }
}
Write-Host '=== /mesh/v1/health ==='
$h = Get-Json '/mesh/v1/health'
if ($h) { $h | ConvertTo-Json -Depth 8 }
Write-Host '=== /mesh/v1/peers ==='
$p = Get-Json '/mesh/v1/peers'
if ($p) {
  $p.peers | Select-Object machine, host, port, online, lastSeen, @{n='version';e={$_.version}} | Format-Table -AutoSize
}
Write-Host '=== /mesh/v1/tasks ==='
$t = Get-Json '/mesh/v1/tasks'
if ($t) { $t.tasks | Select-Object id, status, thread, receivedAt | Format-Table -AutoSize }

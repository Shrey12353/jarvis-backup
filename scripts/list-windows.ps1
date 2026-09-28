# list-windows.ps1 — the titles of windows that are currently open.
$rows = Get-Process |
  Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Trim() -ne "" } |
  Sort-Object ProcessName |
  ForEach-Object { "{0}: {1}" -f $_.ProcessName, $_.MainWindowTitle.Trim() }

if (-not $rows) { Write-Output "(no titled windows found)" } else { $rows | Select-Object -First 40 }

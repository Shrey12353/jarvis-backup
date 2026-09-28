# read-clipboard.ps1 — print the clipboard's text (nothing else).
try {
  $text = Get-Clipboard -Raw -ErrorAction Stop
  if ($null -eq $text) { $text = "" }
  [Console]::Out.Write([string]$text)
} catch {
  try {
    $text = Get-Clipboard -ErrorAction Stop
    if ($text -is [array]) { $text = $text -join "`n" }
    [Console]::Out.Write([string]$text)
  } catch {
    Write-Error "clipboard is not readable right now"
    exit 1
  }
}

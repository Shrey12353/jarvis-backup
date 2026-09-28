# pc-screenshot.ps1 — capture the entire (virtual) screen to a PNG file.
param([Parameter(Mandatory=$true)][string]$Out)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw "screen has no size" }

$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
} finally {
  $g.Dispose()
}
try {
  $dir = Split-Path -Parent $Out
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output $Out
} finally {
  $bmp.Dispose()
}

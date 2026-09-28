# resize-image.ps1 — shrink an image so the vision model reads it quickly.
param(
  [Parameter(Mandatory=$true)][string]$In,
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$Max = 1024
)

Add-Type -AssemblyName System.Drawing

$img = [System.Drawing.Image]::FromFile($In)
try {
  $w = $img.Width; $h = $img.Height
  if ($w -le 0 -or $h -le 0) { throw "image has no size" }
  $scale = [Math]::Min(1.0, [Math]::Min([double]$Max / $w, [double]$Max / $h))
  $nw = [int][Math]::Max(1, [Math]::Round($w * $scale))
  $nh = [int][Math]::Max(1, [Math]::Round($h * $scale))

  $bmp = New-Object System.Drawing.Bitmap $nw, $nh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($img, 0, 0, $nw, $nh)
  } finally {
    $g.Dispose()
  }
  try {
    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output ("{0}x{1} -> {2}x{3}" -f $w, $h, $nw, $nh)
  } finally {
    $bmp.Dispose()
  }
} finally {
  $img.Dispose()
}

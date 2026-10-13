param([int]$x,[int]$y,[int]$w,[int]$h,[string]$out)
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap($w,$h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x,$y,0,0,$bmp.Size)
$bmp.Save($out,[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "snap $x,$y ${w}x${h} -> $out"

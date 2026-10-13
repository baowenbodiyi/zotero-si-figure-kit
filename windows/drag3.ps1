Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshMouse3 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP   = 0x0004;
}
"@
# Slow drag. pdf.js updates the selection on mousemove; 24 steps / 15ms is too
# fast and gets coalesced, which showed up as "selection stops mid-word".
# NOTE: keep this file ASCII-only. A .ps1 with non-ASCII comments but no BOM is
# read as ANSI by Windows PowerShell and the script fails to parse (args empty).
$x1=[int]$args[0]; $y1=[int]$args[1]; $x2=[int]$args[2]; $y2=[int]$args[3]
Write-Output "parsed: $x1,$y1 -> $x2,$y2"
$steps = 80
[DshMouse3]::SetCursorPos($x1,$y1) | Out-Null
Start-Sleep -Milliseconds 400
[DshMouse3]::mouse_event([DshMouse3]::LEFTDOWN,0,0,0,[IntPtr]::Zero)
Start-Sleep -Milliseconds 350
for ($i=1; $i -le $steps; $i++) {
  $x = [int]($x1 + ($x2-$x1)*$i/$steps)
  $y = [int]($y1 + ($y2-$y1)*$i/$steps)
  [DshMouse3]::SetCursorPos($x,$y) | Out-Null
  Start-Sleep -Milliseconds 30
}
Start-Sleep -Milliseconds 400
# Overshoot past the end, then come back: forces pdf.js to recompute the
# selection boundary at the final position.
[DshMouse3]::SetCursorPos($x2 + 30, $y2) | Out-Null
Start-Sleep -Milliseconds 250
[DshMouse3]::SetCursorPos($x2, $y2) | Out-Null
Start-Sleep -Milliseconds 400
[DshMouse3]::mouse_event([DshMouse3]::LEFTUP,0,0,0,[IntPtr]::Zero)
Start-Sleep -Milliseconds 600
Write-Output "drag3 done"

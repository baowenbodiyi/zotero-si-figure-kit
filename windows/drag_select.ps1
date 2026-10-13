Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP   = 0x0004;
}
"@
$y = [int]$args[0]
$x1 = [int]$args[1]
$x2 = [int]$args[2]
[DshMouse]::SetCursorPos($x1, $y) | Out-Null
Start-Sleep -Milliseconds 200
[DshMouse]::mouse_event([DshMouse]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 120
$step = 20
if ($x2 -lt $x1) { $step = -20 }
for ($x = $x1; ; $x += $step) {
  if (($step -gt 0 -and $x -ge $x2) -or ($step -lt 0 -and $x -le $x2)) { break }
  [DshMouse]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 12
}
[DshMouse]::SetCursorPos($x2, $y) | Out-Null
Start-Sleep -Milliseconds 150
[DshMouse]::mouse_event([DshMouse]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 400
Write-Output "drag done $x1,$y -> $x2,$y"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshMouse2 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP   = 0x0004;
  public const uint WHEEL    = 0x0800;
}
"@
$mode = $args[0]
if ($mode -eq 'wheel') {
  $delta = [int]$args[1]
  $u = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$delta), 0)
  [DshMouse2]::mouse_event([DshMouse2]::WHEEL, 0, 0, $u, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 350
  exit 0
}
$x1=[int]$args[0]; $y1=[int]$args[1]; $x2=[int]$args[2]; $y2=[int]$args[3]
[DshMouse2]::SetCursorPos($x1,$y1) | Out-Null
Start-Sleep -Milliseconds 200
[DshMouse2]::mouse_event([DshMouse2]::LEFTDOWN,0,0,0,[IntPtr]::Zero)
Start-Sleep -Milliseconds 150
$steps = 24
for ($i=1; $i -le $steps; $i++) {
  $x = [int]($x1 + ($x2-$x1)*$i/$steps)
  $y = [int]($y1 + ($y2-$y1)*$i/$steps)
  [DshMouse2]::SetCursorPos($x,$y) | Out-Null
  Start-Sleep -Milliseconds 15
}
Start-Sleep -Milliseconds 150
[DshMouse2]::mouse_event([DshMouse2]::LEFTUP,0,0,0,[IntPtr]::Zero)
Start-Sleep -Milliseconds 300
Write-Output "drag2d $x1,$y1 -> $x2,$y2"

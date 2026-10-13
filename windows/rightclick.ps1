Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshRC {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  public const uint RIGHTDOWN = 0x0008;
  public const uint RIGHTUP   = 0x0010;
}
"@
$x=[int]$args[0]; $y=[int]$args[1]
[DshRC]::SetCursorPos($x,$y) | Out-Null
Start-Sleep -Milliseconds 250
[DshRC]::mouse_event([DshRC]::RIGHTDOWN,0,0,0,[IntPtr]::Zero)
Start-Sleep -Milliseconds 80
[DshRC]::mouse_event([DshRC]::RIGHTUP,0,0,0,[IntPtr]::Zero)
Start-Sleep -Milliseconds 400
Write-Output "right-click at $x,$y"

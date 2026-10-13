Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshMoveWheel {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  public const uint WHEEL = 0x0800;
}
"@
# ASCII only: a .ps1 with non-ASCII comments and no BOM breaks Windows PowerShell.
$x=[int]$args[0]; $y=[int]$args[1]; $delta=[int]$args[2]
[DshMoveWheel]::SetCursorPos($x,$y) | Out-Null
Start-Sleep -Milliseconds 250
$u = [BitConverter]::ToUInt32([BitConverter]::GetBytes($delta), 0)
[DshMoveWheel]::mouse_event([DshMoveWheel]::WHEEL, 0, 0, $u, [IntPtr]::Zero)
Start-Sleep -Milliseconds 500
Write-Output "movewheel $x,$y delta=$delta"

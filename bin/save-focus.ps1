# save-focus.ps1 - Save current foreground window handle to file
$fgFile = Join-Path (Join-Path $env:USERPROFILE ".pi") "agent"
$fgFile = Join-Path $fgFile ".pi-wm-fgwindow"

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@

$hwnd = [Win]::GetForegroundWindow()
$hwnd.ToInt64() | Set-Content $fgFile -Force

exit 0
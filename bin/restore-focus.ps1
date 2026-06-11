# restore-focus.ps1 - Save foreground window, restore focus after terminal launch
# Called by pi-workspace-manager's launchTerminalDetached for pi_reload
# Usage: restore-focus.ps1 save | restore

$fgFile = Join-Path (Join-Path $env:USERPROFILE ".pi") "agent"
$fgFile = Join-Path $fgFile ".pi-wm-fgwindow"

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32F {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(int a,int b,bool f);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h,out int p);
  [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h,StringBuilder t,int c);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int a,bool b,int p);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("psapi.dll")] public static extern uint GetModuleFileNameEx(IntPtr h,IntPtr m,StringBuilder f,uint s);
  const int QLI = 0x1000;
  public static string GetTitle(IntPtr h){int l=GetWindowTextLength(h);if(l==0)return"";var sb=new StringBuilder(l+1);GetWindowText(h,sb,sb.Capacity);return sb.ToString();}
  static string GetPath(IntPtr w){int p=0;GetWindowThreadProcessId(w,out p);if(p==0)return"";try{var hp=OpenProcess(QLI,false,p);if(hp==IntPtr.Zero)return"";var sb=new StringBuilder(1024);GetModuleFileNameEx(hp,IntPtr.Zero,sb,1024);CloseHandle(hp);return sb.ToString().ToLower();}catch{return"";}}
  public static bool IsTerminal(IntPtr w){string p=GetPath(w);string t=GetTitle(w).ToLower();return p.Contains("alacritty")||p.Contains("windows terminal")||p.Contains("mintty")||p.Contains("conhost")||t.Contains("alacritty")||t.Contains("mingw")||t.Contains("bash")||t.Contains("cmd.exe")||t.Contains("powershell");}
}
'@

if ($args[0] -eq "save") {
  $fg = [Win32F]::GetForegroundWindow()
  if (-not [Win32F]::IsTerminal($fg)) {
    $fg.ToInt64() | Set-Content $fgFile -Force
  }
  exit 0
}

if ($args[0] -eq "restore") {
  if (Test-Path $fgFile) {
    $hwnd = [IntPtr]::new([long](Get-Content $fgFile))
    Remove-Item $fgFile -Force
    Start-Sleep -Milliseconds 150
    try {
      $mt = [Win32F]::GetCurrentThreadId()
      $d = 0; $ft = [Win32F]::GetWindowThreadProcessId($hwnd, [ref]$d)
      [Win32F]::AttachThreadInput($mt, $ft, $true) | Out-Null
      [Win32F]::SetForegroundWindow($hwnd) | Out-Null
      [Win32F]::AttachThreadInput($mt, $ft, $false) | Out-Null
    } catch {}
  }
  exit 0
}

exit 0
param(
  [Parameter(Mandatory = $true)][string]$ProcessName,
  [switch]$Restore
)

# 枚举某个进程的全部顶层窗口（包括已隐藏的），用于验证"隐藏到托盘"与"从托盘唤回"。
# Get-Process 的 MainWindowHandle 只认可见窗口，窗口一隐藏就变成 0，所以必须自己枚举。
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WinEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  public static List<IntPtr> ForProcess(uint targetPid) {
    var result = new List<IntPtr>();
    EnumWindows((hWnd, lParam) => {
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (pid == targetPid) result.Add(hWnd);
      return true;
    }, IntPtr.Zero);
    return result;
  }

  public static string TitleOf(IntPtr hWnd) {
    int length = GetWindowTextLength(hWnd);
    if (length == 0) return "";
    var buffer = new StringBuilder(length + 1);
    GetWindowText(hWnd, buffer, buffer.Capacity);
    return buffer.ToString();
  }
}
'@

$procs = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
if (($procs | Measure-Object).Count -eq 0) {
  Write-Output "NO_PROCESS"
  exit 2
}

foreach ($proc in $procs) {
  foreach ($hWnd in [WinEnum]::ForProcess([uint32]$proc.Id)) {
    $title = [WinEnum]::TitleOf($hWnd)
    if ($title -eq "") { continue }
    $visible = [WinEnum]::IsWindowVisible($hWnd)
    Write-Output "pid=$($proc.Id) hwnd=$hWnd visible=$visible title='$title'"
    if ($Restore -and -not $visible) {
      [void][WinEnum]::ShowWindow($hWnd, 5)   # SW_SHOW
      Start-Sleep -Milliseconds 1200
      Write-Output "  after restore -> visible=$([WinEnum]::IsWindowVisible($hWnd))"
    }
  }
}

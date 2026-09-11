param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][string]$OutPath,
  [string]$TitleLike = "",
  [int]$DelaySeconds = 2
)

# 按进程名（可再按窗口标题过滤）截取窗口。
# Electron 是多进程，同名进程会有一堆没有窗口的，必须挑出真正带窗口的那个。
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

Start-Sleep -Seconds $DelaySeconds

$candidates = Get-Process -Name $Name -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 }
if ($TitleLike -ne "") {
  $candidates = $candidates | Where-Object { $_.MainWindowTitle -like $TitleLike }
}
$proc = $candidates | Select-Object -First 1

if ($null -eq $proc) {
  Write-Output "NO_WINDOW"
  exit 2
}

$signature = @'
using System;
using System.Runtime.InteropServices;
public class Win32Capture {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
if (-not ("Win32Capture" -as [type])) { Add-Type -TypeDefinition $signature }

[void][Win32Capture]::ShowWindow($proc.MainWindowHandle, 9)   # SW_RESTORE
[void][Win32Capture]::SetForegroundWindow($proc.MainWindowHandle)
Start-Sleep -Milliseconds 900

$rect = New-Object Win32Capture+RECT
[void][Win32Capture]::GetWindowRect($proc.MainWindowHandle, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
$bitmap.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()

Write-Output "OK $($proc.Id) '$($proc.MainWindowTitle)' $width x $height -> $OutPath"

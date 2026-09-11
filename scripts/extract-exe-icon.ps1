param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $true)][string]$OutPath
)

# 从已打包的 exe 里取出图标，用于确认安装包图标确实是客户端 logo。
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$icon = [System.Drawing.Icon]::ExtractAssociatedIcon((Resolve-Path $ExePath).Path)
if ($null -eq $icon) {
  Write-Output "NO_ICON"
  exit 2
}

$bitmap = $icon.ToBitmap()
$bitmap.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
$icon.Dispose()

Write-Output "OK $($bitmap.Width)x$($bitmap.Height) -> $OutPath"

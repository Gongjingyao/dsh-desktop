param(
  [string]$NameLike = "*DSH*"
)

# 用 UI Automation 枚举任务栏通知区域（含被折叠隐藏的图标），确认托盘图标确实注册成功。
# 截图看不到是因为 Windows 默认把新图标放进折叠区，不代表图标不存在。
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$toolbarCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ClassNameProperty, "ToolbarWindow32")

$found = @()
$toolbars = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $toolbarCondition)
Write-Output "通知区域工具栏数量: $($toolbars.Count)"

foreach ($toolbar in $toolbars) {
  $buttons = $toolbar.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($button in $buttons) {
    $name = $button.Current.Name
    if ($name -eq "") { continue }
    $match = $name -like $NameLike
    Write-Output ("  {0} {1}" -f ($(if ($match) { "[命中]" } else { "      " })), $name)
    if ($match) { $found += $name }
  }
}

if ($found.Count -gt 0) {
  Write-Output "FOUND: $($found -join ', ')"
  exit 0
}
Write-Output "NOT_FOUND"
exit 1

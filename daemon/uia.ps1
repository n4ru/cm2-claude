param([string]$mode="dump",[string]$target="")
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$AE=[System.Windows.Automation.AutomationElement]; $TS=[System.Windows.Automation.TreeScope]; $CT=[System.Windows.Automation.ControlType]
$root=$AE::RootElement
$win=$null
foreach($pr in (Get-Process claude -ErrorAction SilentlyContinue|?{$_.MainWindowHandle -ne 0})){
  $c=New-Object System.Windows.Automation.PropertyCondition($AE::NativeWindowHandleProperty,[int]$pr.MainWindowHandle)
  $w=$root.FindFirst($TS::Children,$c); if($w){$win=$w;break}
}
if(-not $win){"NO_WINDOW";exit 1}
function ByName($n){ New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty,$n) }
function InvokeEl($el){
  try{ $p=$el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $p.Invoke(); return "INVOKED" }catch{}
  try{ $p=$el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); $p.Toggle(); return "TOGGLED" }catch{}
  try{ $p=$el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern); $p.Select(); return "SELECTED" }catch{}
  try{ $p=$el.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern); $p.DoDefaultAction(); return "DEFAULTACTION" }catch{}
  return $null
}
function OpenSidebar {
  $b=$win.FindFirst($TS::Descendants,(ByName "Show sidebar"))
  if($b){ [void](InvokeEl $b); Start-Sleep -Milliseconds 300; return $true }
  return $false
}
if($mode -eq "opensidebar"){ if(OpenSidebar){"OPENED"}else{"ALREADY_OPEN"}; exit 0 }
if($mode -eq "select"){
  if(-not $target){"NO_TARGET";exit 2}
  OpenSidebar | Out-Null
  # sidebar session buttons are named "<status> <title>" e.g. "Running Inkboy project setup"; the row menu is "More options for <title>".
  # Collect rows ending with the title, then prefer one whose prefix (the bit before " <title>") is a single status word,
  # so target "project setup" does NOT grab "Running Inkboy project setup" (prefix "Running Inkboy" has a space).
  $btnCond=New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty,$CT::Button)
  $cands=@()
  foreach($b in $win.FindAll($TS::Descendants,$btnCond)){
    $n=$b.Current.Name
    if($n -and $n.EndsWith(" "+$target) -and -not $n.StartsWith("More options for") -and -not $n.EndsWith(", rename session")){ $cands += $b }
  }
  $best = $cands | Where-Object { $_.Current.Name.Substring(0, $_.Current.Name.Length - $target.Length - 1) -notmatch " " } | Select-Object -First 1
  if(-not $best){ $best = $cands | Select-Object -First 1 }
  if($best){ $r=InvokeEl $best; if($r){"$r [$($best.Current.Name)]"; exit 0} }
  "NOTFOUND"; exit 3
}
if($mode -eq "invoke"){
  # click a control by exact accessible name (Send, Dictate, "Fork from here", ...) via UI Automation; a menu item ("Fork
  # from here") may sit behind a "More options" button we open first. Exact-name match, first hit wins.
  if(-not $target){"NO_TARGET";exit 2}
  $btnCond=New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty,$CT::Button)
  $found=$false
  foreach($b in $win.FindAll($TS::Descendants,$btnCond)){ if($b.Current.Name -eq $target){ $found=$true; $r=InvokeEl $b; if($r){"$r"; exit 0} } }
  # not visible: open the newest row's "More options" menu, then retry
  $more = $win.FindAll($TS::Descendants,$btnCond) | Where-Object { $_.Current.Name -like "More options for*" } | Select-Object -Last 1
  if($more){ [void](InvokeEl $more); Start-Sleep -Milliseconds 350
    foreach($b in $win.FindAll($TS::Descendants,$btnCond)){ if($b.Current.Name -eq $target){ $found=$true; $r=InvokeEl $b; if($r){"$r"; exit 0} } } }
  if($found){"FOUND_NO_PATTERN"; exit 4}
  "NOTFOUND"; exit 3
}
if($mode -eq "current"){
  $btnCond=New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty,$CT::Button)
  foreach($b in $win.FindAll($TS::Descendants,$btnCond)){ $n=$b.Current.Name; if($n -match '^(.*), rename session$'){ $Matches[1]; exit 0 } }
  "UNKNOWN"; exit 0
}
$seen=@{}
foreach($ctName in @("ListItem","Hyperlink","Button","TreeItem")){
  $c=New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty,$CT::$ctName)
  foreach($e in $win.FindAll($TS::Descendants,$c)){ $n=$e.Current.Name; if($n -and -not $seen.ContainsKey("$ctName|$n")){ $seen["$ctName|$n"]=1; "$ctName`t$n" } }
}

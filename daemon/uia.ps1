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
  try{ $p=$el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern); $p.Select(); return "SELECTED" }catch{}
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

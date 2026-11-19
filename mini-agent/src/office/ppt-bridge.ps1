# ppt-bridge.ps1 - persistent PowerPoint COM bridge for mini-agent.
# Protocol: one JSON object per line on stdin  {"id":1,"cmd":"state","args":{...}}
#           one JSON object per line on stdout {"id":1,"ok":true,"data":...} / {"id":1,"ok":false,"error":"..."}
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 reads BOM-less files as ANSI).
# All geometry is in points (a default 16:9 slide is 960 x 540).

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true
$stdout.NewLine = "`n"

function Send($obj) { $stdout.WriteLine(($obj | ConvertTo-Json -Depth 12 -Compress)) }

$script:app = $null
function Get-App([bool]$create) {
  if ($script:app) { try { $null = $script:app.Name; return $script:app } catch { $script:app = $null } }
  try { $script:app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') }
  catch {
    if ($create) { $script:app = New-Object -ComObject PowerPoint.Application; $script:app.Visible = -1 }
  }
  return $script:app
}

function Need-Pres($app) {
  if (-not $app) { throw 'NO_POWERPOINT: PowerPoint is not running' }
  if ($app.Presentations.Count -lt 1) { throw 'NO_PRESENTATION: no presentation is open in PowerPoint' }
  return $app.ActivePresentation
}

function To-Hex($bgr) {
  $v = [int]$bgr
  return ('{0:X2}{1:X2}{2:X2}' -f ($v -band 255), (($v -shr 8) -band 255), (($v -shr 16) -band 255))
}
function From-Hex([string]$h) {
  $h = $h.Trim().TrimStart('#')
  if ($h.Length -ne 6) { throw "bad color '$h' (use RRGGBB hex)" }
  $r = [Convert]::ToInt32($h.Substring(0,2),16); $g = [Convert]::ToInt32($h.Substring(2,2),16); $b = [Convert]::ToInt32($h.Substring(4,2),16)
  return [int]($r + ($g * 256) + ($b * 65536))
}
function Has($o, [string]$k) { return ($o -is [System.Collections.IDictionary] -and $o.Contains($k)) -or ($o.PSObject.Properties.Name -contains $k) }
function Arg($o, [string]$k, $def = $null) { if ($null -ne $o -and (Has $o $k) -and $null -ne $o.$k) { return $o.$k } else { return $def } }
function R1($n) { return [math]::Round([double]$n, 1) }

$KIND = @{ 1='autoshape'; 2='callout'; 3='chart'; 5='freeform'; 6='group'; 7='ole'; 9='line'; 11='linked_picture'; 13='picture'; 14='placeholder'; 16='media'; 17='textbox'; 19='table'; 20='canvas'; 21='smartart'; 24='graphic' }
$SHAPES = @{
  'rectangle'=1; 'parallelogram'=2; 'trapezoid'=3; 'diamond'=4; 'rounded_rectangle'=5; 'octagon'=6; 'triangle'=7; 'right_triangle'=8;
  'oval'=9; 'circle'=9; 'hexagon'=10; 'cross'=11; 'pentagon'=12; 'can'=13; 'cube'=14; 'smiley'=17; 'donut'=18; 'heart'=21;
  'lightning'=22; 'sun'=23; 'moon'=24; 'right_arrow'=33; 'left_arrow'=34; 'up_arrow'=35; 'down_arrow'=36; 'star'=92;
  'chevron'=52; 'homeplate'=51; 'teardrop'=160; 'cloud'=179; 'callout'=105
}

function Active-Index($app) {
  try { return [int]$app.ActiveWindow.View.Slide.SlideIndex } catch { return 1 }
}
function Get-Slide($app, $pres, $ref) {
  $i = 0
  if ($null -eq $ref -or "$ref" -eq 'active' -or "$ref" -eq '') { $i = Active-Index $app } else { $i = [int]$ref }
  if ($i -lt 1 -or $i -gt $pres.Slides.Count) { throw "slide $i out of range (1..$($pres.Slides.Count))" }
  $script:touched = $i
  return $pres.Slides.Item($i)
}
# Bring a slide (and optionally a shape) into view in the PowerPoint window. Never throws.
function Reveal($app, $pres, [int]$i, $shape) {
  try {
    if ($app.Windows.Count -lt 1) { return $false }
    if ($i -lt 1) { return $false }
    if ($i -gt $pres.Slides.Count) { $i = $pres.Slides.Count }
    $view = $app.ActiveWindow.View
    if ([int]$view.Slide.SlideIndex -ne $i) { $view.GotoSlide($i) }
    if ($shape) {
      try { $app.ActiveWindow.ScrollIntoView([double]$shape.Left, [double]$shape.Top, [double]$shape.Width, [double]$shape.Height, -1) } catch {}
    }
    return $true
  } catch { return $false }
}
function Find-Shape($app, $sl, $ref) {
  if ($null -eq $ref -or "$ref" -eq '') { throw 'shape is required (name or id; "selection" = the selected shape)' }
  if ("$ref" -eq 'selection') {
    try { return $app.ActiveWindow.Selection.ShapeRange.Item(1) } catch { throw 'nothing is selected in PowerPoint' }
  }
  foreach ($s in $sl.Shapes) { if ($s.Name -eq "$ref" -or "$($s.Id)" -eq "$ref") { return $s } }
  throw "shape not found: $ref (use ppt_read to list the names/ids on this slide)"
}

function Dump-Shape($s, [int]$z) {
  $o = [ordered]@{}
  $o.id = [int]$s.Id; $o.name = [string]$s.Name; $t = [int]$s.Type
  $o.kind = if ($KIND.ContainsKey($t)) { $KIND[$t] } else { "type$t" }
  $o.left = R1 $s.Left; $o.top = R1 $s.Top; $o.width = R1 $s.Width; $o.height = R1 $s.Height
  $o.rotation = R1 $s.Rotation; $o.z = $z; $o.visible = ($s.Visible -ne 0)
  if ($t -eq 14) { try { $o.placeholder = [int]$s.PlaceholderFormat.Type } catch {} }
  if ($t -eq 6) { try { $o.children = [int]$s.GroupItems.Count } catch {} }
  try { if ($s.AlternativeText) { $o.alt = [string]$s.AlternativeText } } catch {}
  try {
    if ($s.HasTextFrame -ne 0) {
      $tf = $s.TextFrame
      $o.autosize = [int]$tf.AutoSize
      if ($tf.HasText -ne 0) {
        $tr = $tf.TextRange
        $o.text = [string]$tr.Text
        $o.paragraphs = [int]$tr.Paragraphs().Count
        $f = $tr.Font
        $o.font = [string]$f.Name; $o.size = [double]$f.Size; $o.bold = ($f.Bold -ne 0); $o.color = To-Hex $f.Color.RGB
        $o.textWidth = R1 $tr.BoundWidth; $o.textHeight = R1 $tr.BoundHeight
        $o.marginL = R1 $tf.MarginLeft; $o.marginT = R1 $tf.MarginTop
      }
    }
  } catch {}
  try { if ($s.Fill.Visible -ne 0 -and $t -ne 13) { $o.fill = To-Hex $s.Fill.ForeColor.RGB } } catch {}
  try { if ($s.Line.Visible -ne 0 -and $t -ne 13) { $o.line = To-Hex $s.Line.ForeColor.RGB; $o.lineWidth = R1 $s.Line.Weight } } catch {}
  return $o
}

function Dump-Slide($app, $pres, [int]$i) {
  $sl = $pres.Slides.Item($i)
  $shapes = New-Object System.Collections.ArrayList
  $z = 0
  foreach ($s in $sl.Shapes) { $z++; [void]$shapes.Add((Dump-Shape $s $z)) }
  $o = [ordered]@{ index = $i; layout = [string]$sl.CustomLayout.Name; shapes = $shapes.ToArray() }
  try {
    $o.followMasterBackground = ($sl.FollowMasterBackground -ne 0)
    $bg = if ($sl.FollowMasterBackground -ne 0) { $pres.SlideMaster.Background.Fill } else { $sl.Background.Fill }
    if ([int]$bg.Type -eq 1) { $o.background = To-Hex $bg.ForeColor.RGB }
  } catch {}
  try { $o.notes = [string]$sl.NotesPage.Shapes.Placeholders(2).TextFrame.TextRange.Text } catch {}
  return $o
}

function Theme-Info($pres) {
  $o = [ordered]@{}
  try {
    $cs = $pres.SlideMaster.Theme.ThemeColorScheme
    $names = @('dark1','light1','dark2','light2','accent1','accent2','accent3','accent4','accent5','accent6','hyperlink','followed')
    $c = [ordered]@{}
    for ($k = 1; $k -le 12; $k++) { $c[$names[$k-1]] = To-Hex $cs.Colors($k).RGB }
    $o.colors = $c
  } catch {}
  try {
    $fs = $pres.SlideMaster.Theme.ThemeFontScheme
    $o.majorFont = [string]$fs.MajorFont.Item(1).Name; $o.minorFont = [string]$fs.MinorFont.Item(1).Name
  } catch {}
  return $o
}

function Selection-Info($app) {
  $o = [ordered]@{ type = 'none' }
  try {
    if ($app.Windows.Count -lt 1) { return $o }
    $sel = $app.ActiveWindow.Selection
    switch ([int]$sel.Type) {
      1 { $o.type = 'slides'; $o.slides = @($sel.SlideRange | ForEach-Object { [int]$_.SlideIndex }) }
      2 { $o.type = 'shapes'; $o.shapes = @($sel.ShapeRange | ForEach-Object { [ordered]@{ id = [int]$_.Id; name = [string]$_.Name } }) }
      3 { $o.type = 'text'; $o.text = [string]$sel.TextRange.Text }
    }
  } catch {}
  return $o
}

function Fingerprint($app) {
  $pres = Need-Pres $app
  $i = Active-Index $app
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append("$($pres.FullName)|$($pres.Slides.Count)|$i|")
  $sl = $pres.Slides.Item($i)
  foreach ($s in $sl.Shapes) {
    [void]$sb.Append("$($s.Id),$($s.Name),$([math]::Round($s.Left,1)),$([math]::Round($s.Top,1)),$([math]::Round($s.Width,1)),$([math]::Round($s.Height,1)),$([math]::Round($s.Rotation,1));")
    try { if ($s.HasTextFrame -ne 0 -and $s.TextFrame.HasText -ne 0) { [void]$sb.Append("$($s.TextFrame.TextRange.Text)|$($s.TextFrame.TextRange.Font.Size)|$($s.TextFrame.TextRange.Font.Color.RGB);") } } catch {}
    try { if ($s.Fill.Visible -ne 0) { [void]$sb.Append("f$($s.Fill.ForeColor.RGB);") } } catch {}
  }
  $md5 = [System.Security.Cryptography.MD5]::Create()
  $h = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($sb.ToString()))
  return @{ fp = ([BitConverter]::ToString($h) -replace '-', ''); slide = $i }
}

function Apply-Format($s, $a) {
  $tr = $null
  try { if ($s.HasTextFrame -ne 0) { $tr = $s.TextFrame.TextRange } } catch {}
  if ($tr) {
    if (Has $a 'font')   { $tr.Font.Name = [string]$a.font }
    if (Has $a 'size')   { $tr.Font.Size = [double]$a.size }
    if (Has $a 'bold')   { $tr.Font.Bold = $(if ($a.bold) { -1 } else { 0 }) }
    if (Has $a 'italic') { $tr.Font.Italic = $(if ($a.italic) { -1 } else { 0 }) }
    if (Has $a 'color')  { $tr.Font.Color.RGB = (From-Hex $a.color) }
    if (Has $a 'align')  {
      $m = @{ left = 1; center = 2; right = 3; justify = 4 }
      if (-not $m.ContainsKey([string]$a.align)) { throw "align must be left|center|right|justify" }
      $tr.ParagraphFormat.Alignment = $m[[string]$a.align]
    }
    if (Has $a 'valign') {
      $m = @{ top = 1; middle = 3; bottom = 4 }
      if (-not $m.ContainsKey([string]$a.valign)) { throw "valign must be top|middle|bottom" }
      $s.TextFrame.VerticalAnchor = $m[[string]$a.valign]
    }
    if (Has $a 'autosize') { $s.TextFrame.AutoSize = $(if ($a.autosize) { 1 } else { 0 }) }
    if (Has $a 'wrap')     { $s.TextFrame.WordWrap = $(if ($a.wrap) { -1 } else { 0 }) }
  }
  if (Has $a 'fill') {
    if ($null -eq $a.fill -or "$($a.fill)" -eq 'none') { $s.Fill.Visible = 0 } else { $s.Fill.Visible = -1; $s.Fill.Solid(); $s.Fill.ForeColor.RGB = (From-Hex $a.fill) }
  }
  if (Has $a 'transparency') { $s.Fill.Transparency = [double]$a.transparency }
  if (Has $a 'line') {
    if ($null -eq $a.line -or "$($a.line)" -eq 'none') { $s.Line.Visible = 0 } else { $s.Line.Visible = -1; $s.Line.ForeColor.RGB = (From-Hex $a.line) }
  }
  if (Has $a 'line_width') { $s.Line.Visible = -1; $s.Line.Weight = [double]$a.line_width }
  if (Has $a 'alt') { $s.AlternativeText = [string]$a.alt }
}

function Apply-Geometry($s, $a) {
  if (Has $a 'left')     { $s.Left = [double]$a.left }
  if (Has $a 'top')      { $s.Top = [double]$a.top }
  if (Has $a 'width')    { $s.Width = [double]$a.width }
  if (Has $a 'height')   { $s.Height = [double]$a.height }
  if (Has $a 'rotation') { $s.Rotation = [double]$a.rotation }
}

function Do-Op($app, $pres, $op) {
  $kind = [string](Arg $op 'op')
  switch ($kind) {
    'add_textbox' {
      $sl = Get-Slide $app $pres (Arg $op 'slide')
      $s = $sl.Shapes.AddTextbox(1, [double](Arg $op 'left' 60), [double](Arg $op 'top' 60), [double](Arg $op 'width' 300), [double](Arg $op 'height' 40))
      $s.TextFrame.TextRange.Text = [string](Arg $op 'text' '')
      if (Has $op 'name') { $s.Name = [string]$op.name }
      Apply-Format $s $op
      return "added textbox '$($s.Name)' (id $($s.Id)) on slide $($sl.SlideIndex)"
    }
    'add_shape' {
      $sl = Get-Slide $app $pres (Arg $op 'slide')
      $sn = [string](Arg $op 'shape' 'rectangle')
      if (-not $SHAPES.ContainsKey($sn)) { throw "unknown shape '$sn'. Known: $(($SHAPES.Keys | Sort-Object) -join ', ')" }
      $s = $sl.Shapes.AddShape($SHAPES[$sn], [double](Arg $op 'left' 100), [double](Arg $op 'top' 100), [double](Arg $op 'width' 100), [double](Arg $op 'height' 100))
      if (Has $op 'name') { $s.Name = [string]$op.name }
      if (Has $op 'rotation') { $s.Rotation = [double]$op.rotation }
      if (Has $op 'text') { $s.TextFrame.TextRange.Text = [string]$op.text }
      if (-not (Has $op 'line') -and -not (Has $op 'line_width')) { $s.Line.Visible = 0 }
      Apply-Format $s $op
      return "added shape '$($s.Name)' ($sn, id $($s.Id)) on slide $($sl.SlideIndex)"
    }
    'add_line' {
      $sl = Get-Slide $app $pres (Arg $op 'slide')
      $s = $sl.Shapes.AddLine([double](Arg $op 'x1' 0), [double](Arg $op 'y1' 0), [double](Arg $op 'x2' 100), [double](Arg $op 'y2' 0))
      if (Has $op 'name') { $s.Name = [string]$op.name }
      $s.Line.ForeColor.RGB = (From-Hex (Arg $op 'color' '000000'))
      $s.Line.Weight = [double](Arg $op 'weight' 1.5)
      return "added line '$($s.Name)' (id $($s.Id)) on slide $($sl.SlideIndex)"
    }
    'add_picture' {
      $sl = Get-Slide $app $pres (Arg $op 'slide')
      $p = [string](Arg $op 'path')
      if (-not (Test-Path -LiteralPath $p)) { throw "picture file not found: $p" }
      $hasW = Has $op 'width'; $hasH = Has $op 'height'
      $s = $sl.Shapes.AddPicture($p, 0, -1, [double](Arg $op 'left' 100), [double](Arg $op 'top' 100), -1, -1)
      $s.LockAspectRatio = -1
      if ($hasW -and $hasH) { $s.LockAspectRatio = 0; $s.Width = [double]$op.width; $s.Height = [double]$op.height }
      elseif ($hasW) { $s.Width = [double]$op.width }
      elseif ($hasH) { $s.Height = [double]$op.height }
      if (Has $op 'name') { $s.Name = [string]$op.name }
      if (Has $op 'rotation') { $s.Rotation = [double]$op.rotation }
      if (Has $op 'alt') { $s.AlternativeText = [string]$op.alt }
      return "added picture '$($s.Name)' (id $($s.Id)) on slide $($sl.SlideIndex) at ($(R1 $s.Left),$(R1 $s.Top)) size $(R1 $s.Width)x$(R1 $s.Height)"
    }
    'set_text' {
      $sl = Get-Slide $app $pres (Arg $op 'slide')
      $s = Find-Shape $app $sl (Arg $op 'shape')
      if ($s.HasTextFrame -eq 0) { throw "shape '$($s.Name)' cannot hold text" }
      $s.TextFrame.TextRange.Text = [string](Arg $op 'text' '')
      return "set text of '$($s.Name)'"
    }
    'format' {
      $sl = Get-Slide $app $pres (Arg $op 'slide')
      $s = Find-Shape $app $sl (Arg $op 'shape')
      Apply-Format $s $op
      return "formatted '$($s.Name)'"
    }
    'geometry' {
      $sl = Get-Slide $app $pres (Arg $op 'slide')
      $s = Find-Shape $app $sl (Arg $op 'shape')
      Apply-Geometry $s $op
      return "'$($s.Name)' now at ($(R1 $s.Left),$(R1 $s.Top)) size $(R1 $s.Width)x$(R1 $s.Height) rot $(R1 $s.Rotation)"
    }
    'z_order' {
      $sl = Get-Slide $app $pres (Arg $op 'slide')
      $s = Find-Shape $app $sl (Arg $op 'shape')
      $m = @{ front = 0; back = 1; forward = 2; backward = 3 }
      $a = [string](Arg $op 'action' 'front')
      if (-not $m.ContainsKey($a)) { throw 'action must be front|back|forward|backward' }
      $s.ZOrder($m[$a])
      return "z-order of '$($s.Name)': $a"
    }
    'delete_shape' {
      $sl = Get-Slide $app $pres (Arg $op 'slide')
      $s = Find-Shape $app $sl (Arg $op 'shape')
      $n = $s.Name; $s.Delete()
      return "deleted shape '$n'"
    }
    'group' {
      $sl = Get-Slide $app $pres (Arg $op 'slide')
      $names = @(Arg $op 'shapes' @())
      if ($names.Count -lt 2) { throw 'group needs at least 2 shapes' }
      $objs = @($names | ForEach-Object { (Find-Shape $app $sl $_).Name })
      $g = $sl.Shapes.Range([string[]]$objs).Group()
      if (Has $op 'name') { $g.Name = [string]$op.name }
      return "grouped $($names.Count) shapes into '$($g.Name)' (id $($g.Id))"
    }
    'align' {
      $sl = Get-Slide $app $pres (Arg $op 'slide')
      $names = @(Arg $op 'shapes' @())
      if ($names.Count -lt 1) { throw 'align needs shapes' }
      $objs = @($names | ForEach-Object { (Find-Shape $app $sl $_).Name })
      $m = @{ left = 0; center = 1; right = 2; top = 3; middle = 4; bottom = 5 }
      $mode = [string](Arg $op 'mode')
      if (-not $m.ContainsKey($mode)) { throw 'mode must be left|center|right|top|middle|bottom' }
      $rel = $(if ((Arg $op 'relative_to' 'slide') -eq 'slide') { -1 } else { 0 })
      $sl.Shapes.Range([string[]]$objs).Align($m[$mode], $rel)
      return "aligned $($names.Count) shape(s): $mode"
    }
    'distribute' {
      $sl = Get-Slide $app $pres (Arg $op 'slide')
      $names = @(Arg $op 'shapes' @())
      if ($names.Count -lt 3) { throw 'distribute needs at least 3 shapes' }
      $objs = @($names | ForEach-Object { (Find-Shape $app $sl $_).Name })
      $dir = $(if ((Arg $op 'direction' 'horizontal') -eq 'vertical') { 1 } else { 0 })
      $rel = $(if ((Arg $op 'relative_to' 'shapes') -eq 'slide') { -1 } else { 0 })
      $sl.Shapes.Range([string[]]$objs).Distribute($dir, $rel)
      return "distributed $($names.Count) shapes"
    }
    'add_slide' {
      $idx = [int](Arg $op 'index' ($pres.Slides.Count + 1))
      $lay = [string](Arg $op 'layout' 'blank')
      $legacy = @{ title = 1; title_content = 2; title_only = 11; blank = 12 }
      if ($legacy.ContainsKey($lay)) { $sl = $pres.Slides.Add($idx, $legacy[$lay]) }
      else {
        $cl = $null
        foreach ($l in $pres.SlideMaster.CustomLayouts) { if ($l.Name -eq $lay) { $cl = $l } }
        if (-not $cl) { throw "layout '$lay' not found (use title|title_content|title_only|blank or a layout name)" }
        $sl = $pres.Slides.AddSlide($idx, $cl)
      }
      $script:touched = [int]$sl.SlideIndex
      return "added slide $($sl.SlideIndex) (layout $($sl.CustomLayout.Name))"
    }
    'duplicate_slide' {
      $sl = Get-Slide $app $pres (Arg $op 'slide')
      $d = $sl.Duplicate()
      $script:touched = [int]$d.Item(1).SlideIndex
      return "duplicated slide $($sl.SlideIndex) -> new slide $($d.Item(1).SlideIndex)"
    }
    'goto_slide' {
      $sl = Get-Slide $app $pres (Arg $op 'slide')
      $sh = $null
      if (Has $op 'shape') { $sh = Find-Shape $app $sl (Arg $op 'shape') }
      if (-not (Reveal $app $pres ([int]$sl.SlideIndex) $sh)) { throw 'cannot change the view (no PowerPoint window, or it is in a mode that cannot navigate)' }
      return "showing slide $($sl.SlideIndex)"
    }
    'delete_slide' {
      $sl = Get-Slide $app $pres (Arg $op 'slide')
      $n = $sl.SlideIndex; $sl.Delete()
      return "deleted slide $n"
    }
    'move_slide' {
      $sl = Get-Slide $app $pres (Arg $op 'slide')
      $to = [int](Arg $op 'to')
      if ($to -lt 1 -or $to -gt $pres.Slides.Count) { throw "target position $to out of range" }
      $sl.MoveTo($to)
      $script:touched = $to
      return "moved slide to position $to"
    }
    'set_notes' {
      $sl = Get-Slide $app $pres (Arg $op 'slide')
      $sl.NotesPage.Shapes.Placeholders(2).TextFrame.TextRange.Text = [string](Arg $op 'text' '')
      return "set notes of slide $($sl.SlideIndex)"
    }
    'set_background' {
      $sl = Get-Slide $app $pres (Arg $op 'slide')
      $sl.FollowMasterBackground = 0
      $sl.Background.Fill.Solid()
      $sl.Background.Fill.ForeColor.RGB = (From-Hex (Arg $op 'color'))
      return "set background of slide $($sl.SlideIndex)"
    }
    default { throw "unknown op '$kind'" }
  }
}

function Handle($cmd, $a) {
  switch ($cmd) {
    'ping' { return @{ pong = $true } }
    'state' {
      $app = Get-App $false
      if (-not $app) { return @{ running = $false } }
      $list = @($app.Presentations | ForEach-Object { [ordered]@{ name = [string]$_.Name; path = [string]$_.FullName; saved = ($_.Saved -ne 0); slides = [int]$_.Slides.Count } })
      if ($list.Count -lt 1) { return @{ running = $true; presentations = @() } }
      $pres = $app.ActivePresentation
      return [ordered]@{
        running = $true; presentations = $list; active = [string]$pres.Name; path = [string]$pres.FullName; saved = ($pres.Saved -ne 0)
        slideCount = [int]$pres.Slides.Count; slideWidth = R1 $pres.PageSetup.SlideWidth; slideHeight = R1 $pres.PageSetup.SlideHeight
        activeSlide = (Active-Index $app); selection = (Selection-Info $app)
      }
    }
    'dump' {
      $app = Get-App $false; $pres = Need-Pres $app
      $i = $(if ($null -ne (Arg $a 'slide') -and "$(Arg $a 'slide')" -ne 'active') { [int](Arg $a 'slide') } else { Active-Index $app })
      if ($i -lt 1 -or $i -gt $pres.Slides.Count) { throw "slide $i out of range (1..$($pres.Slides.Count))" }
      $o = Dump-Slide $app $pres $i
      if (Arg $a 'theme' $false) { $o.theme = Theme-Info $pres }
      $o.slideWidth = R1 $pres.PageSetup.SlideWidth; $o.slideHeight = R1 $pres.PageSetup.SlideHeight; $o.slideCount = [int]$pres.Slides.Count
      return $o
    }
    'titles' {
      $app = Get-App $false; $pres = Need-Pres $app
      $out = New-Object System.Collections.ArrayList
      foreach ($sl in $pres.Slides) {
        $t = ''
        try { if ($sl.Shapes.HasTitle -ne 0) { $t = [string]$sl.Shapes.Title.TextFrame.TextRange.Text } } catch {}
        [void]$out.Add([ordered]@{ index = [int]$sl.SlideIndex; title = $t; shapes = [int]$sl.Shapes.Count })
      }
      return @{ slides = $out.ToArray() }
    }
    'fingerprint' {
      $app = Get-App $false
      if (-not $app) { return @{ running = $false } }
      if ($app.Presentations.Count -lt 1) { return @{ running = $true; open = $false } }
      $r = Fingerprint $app
      return @{ running = $true; open = $true; fp = $r.fp; slide = $r.slide }
    }
    'export' {
      $app = Get-App $false; $pres = Need-Pres $app
      $sl = Get-Slide $app $pres (Arg $a 'slide')
      $path = [string](Arg $a 'path')
      $dir = Split-Path -Parent $path
      if ($dir -and -not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Force -Path $dir) }
      $w = [int](Arg $a 'width' 1280)
      $h = [int][math]::Round($w * $pres.PageSetup.SlideHeight / $pres.PageSetup.SlideWidth)
      $sl.Export($path, 'PNG', $w, $h)
      return @{ path = $path; slide = [int]$sl.SlideIndex; width = $w; height = $h }
    }
    'backup' {
      $app = Get-App $false; $pres = Need-Pres $app
      $path = [string](Arg $a 'path')
      $dir = Split-Path -Parent $path
      if ($dir -and -not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Force -Path $dir) }
      $pres.SaveCopyAs($path)
      return @{ path = $path }
    }
    'open' {
      $app = Get-App $true
      $p = [string](Arg $a 'path')
      if (-not (Test-Path -LiteralPath $p)) { throw "file not found: $p" }
      foreach ($pr in $app.Presentations) { if ($pr.FullName -eq (Resolve-Path -LiteralPath $p).Path) { $pr.Windows.Item(1).Activate(); return @{ opened = $pr.Name; already = $true } } }
      $pr = $app.Presentations.Open($p, 0, 0, -1)
      return @{ opened = [string]$pr.Name; slides = [int]$pr.Slides.Count }
    }
    'new' {
      $app = Get-App $true
      $pr = $app.Presentations.Add(-1)
      if ((Arg $a 'blank_first_slide' $true)) { [void]$pr.Slides.Add(1, 12) }
      return @{ name = [string]$pr.Name }
    }
    'save' {
      $app = Get-App $false; $pres = Need-Pres $app
      $p = [string](Arg $a 'path' '')
      if ($p) {
        $dir = Split-Path -Parent $p
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Force -Path $dir) }
        $pres.SaveAs($p)
      } else {
        if (-not $pres.Path) { throw 'this presentation has never been saved; provide a path' }
        $pres.Save()
      }
      return @{ saved = [string]$pres.FullName }
    }
    'close' {
      $app = Get-App $false; $pres = Need-Pres $app
      $n = $pres.Name; $pres.Saved = -1; $pres.Close()
      return @{ closed = $n }
    }
    'edit' {
      $app = Get-App $false; $pres = Need-Pres $app
      $ops = @($a.ops)
      $done = New-Object System.Collections.ArrayList
      $n = 0
      $script:touched = 0
      $reveal = [bool](Arg $a 'reveal' $true)
      foreach ($op in $ops) {
        $n++
        try { [void]$done.Add((Do-Op $app $pres $op)) }
        catch {
          $msg = [string]$_.Exception.Message
          if ($reveal -and $script:touched -gt 0) { [void](Reveal $app $pres $script:touched $null) }
          return [ordered]@{ ok = $false; applied = $done.ToArray(); failedAt = $n; error = $msg }
        }
      }
      # Show the user what changed: jump to the last slide the batch touched (clamped if slides were deleted)
      $shown = 0
      if ($reveal -and $script:touched -gt 0 -and $done.Count -gt 0) { if (Reveal $app $pres $script:touched $null) { $shown = [math]::Min($script:touched, [int]$pres.Slides.Count) } }
      return [ordered]@{ ok = $true; applied = $done.ToArray(); shown = $shown }
    }
    default { throw "unknown command '$cmd'" }
  }
}

Send @{ ready = $true; ps = "$($PSVersionTable.PSVersion)" }
while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $data = Handle ([string]$req.cmd) $req.args
    Send @{ id = $id; ok = $true; data = $data }
  } catch {
    Send @{ id = $id; ok = $false; error = [string]$_.Exception.Message }
  }
}

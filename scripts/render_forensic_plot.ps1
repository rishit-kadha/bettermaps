# scripts/render_forensic_plot.ps1
# Renders artifacts/device_evaluation/road_constraint_forensic_plot.png from road_constraint_forensic_trace.csv using native .NET System.Drawing

Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$csvPath = Join-Path $repoRoot "artifacts\device_evaluation\road_constraint_forensic_trace.csv"
$pngPath = Join-Path $repoRoot "artifacts\device_evaluation\road_constraint_forensic_plot.png"

$rows = Import-Csv -Path $csvPath

$width = 1200
$height = 950
$bmp = New-Object System.Drawing.Bitmap($width, $height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::White)

$fontTitle = New-Object System.Drawing.Font("Arial", 16, [System.Drawing.FontStyle]::Bold)
$fontSub = New-Object System.Drawing.Font("Arial", 12, [System.Drawing.FontStyle]::Bold)
$fontLabel = New-Object System.Drawing.Font("Arial", 10, [System.Drawing.FontStyle]::Regular)
$fontLegend = New-Object System.Drawing.Font("Arial", 10, [System.Drawing.FontStyle]::Bold)

$brushBlack = [System.Drawing.Brushes]::Black
$brushGray = [System.Drawing.Brushes]::DimGray
$brushRed = [System.Drawing.Brushes]::Crimson
$brushGreen = [System.Drawing.Brushes]::DarkGreen
$brushOrange = [System.Drawing.Brushes]::DarkOrange
$brushBlue = [System.Drawing.Brushes]::MediumBlue

$penAxis = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(60, 60, 60), 1.5)
$penGrid = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(230, 230, 230), 1.0)
$penGrid.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash
$penRed = New-Object System.Drawing.Pen([System.Drawing.Color]::Crimson, 2.5)
$penOrange = New-Object System.Drawing.Pen([System.Drawing.Color]::DarkOrange, 2.5)
$penOrangeDash = New-Object System.Drawing.Pen([System.Drawing.Color]::OrangeRed, 1.5)
$penOrangeDash.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash
$penGreen = New-Object System.Drawing.Pen([System.Drawing.Color]::ForestGreen, 2.5)
$penBlackDash = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, 2.5)
$penBlackDash.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash
$penBlueDash = New-Object System.Drawing.Pen([System.Drawing.Color]::MediumBlue, 2.0)
$penBlueDash.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash

$brushOutage = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(40, 180, 180, 180))

$marginLeft = 90
$marginRight = 50
$marginTop = 70
$plotW = $width - $marginLeft - $marginRight
$subH = 220
$gap = 50

$maxT = 120.0
$maxErr = 60.0
$maxCt = 45.0

function Tx($t) { return $marginLeft + ([float]$t / $maxT) * $plotW }
function Ty1($v) { return $marginTop + $subH - ([float]$v / $maxErr) * $subH }
function Ty2($v) { return ($marginTop + $subH + $gap) + $subH - ([float]$v / $maxCt) * $subH }
function Ty3($v) { return ($marginTop + ($subH + $gap) * 2) + $subH - ([float]$v / 1.2) * $subH }

# Title
$g.DrawString("IDR Road/Route Constraint Forensic Trace: IO-VNBD Session S2", $fontTitle, $brushBlack, ($width/2 - 380), 20)

$ox1 = Tx 20.0
$ox2 = Tx 50.0

# ----------------- SUBPLOT 1 -----------------
$y1Top = $marginTop
$y1Bot = $y1Top + $subH
$g.FillRectangle($brushOutage, $ox1, $y1Top, ($ox2 - $ox1), $subH)

for ($v = 0; $v -le $maxErr; $v += 10) {
    $y = Ty1 $v
    $g.DrawLine($penGrid, $marginLeft, $y, ($marginLeft + $plotW), $y)
    $g.DrawString("${v}m", $fontLabel, $brushGray, ($marginLeft - 45), ($y - 7))
}
$g.DrawLine($penAxis, $marginLeft, $y1Bot, ($marginLeft + $plotW), $y1Bot)
$g.DrawLine($penAxis, $marginLeft, $y1Top, $marginLeft, $y1Bot)
$g.DrawLine($penBlueDash, $ox2, $y1Top, $ox2, $y1Bot)

# Plot pos_error_m
for ($i = 0; $i -lt ($rows.Count - 1); $i++) {
    $x_a = Tx $rows[$i].timestamp
    $y_a = Ty1 $rows[$i].pos_error_m
    $x_b = Tx $rows[$i+1].timestamp
    $y_b = Ty1 $rows[$i+1].pos_error_m
    $g.DrawLine($penRed, $x_a, $y_a, $x_b, $y_b)
}
$g.DrawString("1. Position Error (Red) & Post-Outage GNSS Direct Re-anchor Snap", $fontSub, $brushBlack, ($marginLeft + 10), ($y1Top + 10))
$g.DrawString("GNSS Outage Window [20s, 50s]", $fontLegend, $brushGray, ($ox1 + 10), ($y1Top + 35))
$g.DrawString("Post-Outage Snap (52.8m -> 0.19m)", $fontLegend, $brushBlue, ($ox2 + 10), ($y1Top + 140))

# ----------------- SUBPLOT 2 -----------------
$y2Top = $marginTop + $subH + $gap
$y2Bot = $y2Top + $subH
$g.FillRectangle($brushOutage, $ox1, $y2Top, ($ox2 - $ox1), $subH)

for ($v = 0; $v -le $maxCt; $v += 10) {
    $y = Ty2 $v
    $g.DrawLine($penGrid, $marginLeft, $y, ($marginLeft + $plotW), $y)
    $g.DrawString("${v}m", $fontLabel, $brushGray, ($marginLeft - 45), ($y - 7))
}
$yGate = Ty2 30.0
$g.DrawLine($penOrangeDash, $marginLeft, $yGate, ($marginLeft + $plotW), $yGate)
$g.DrawString("maxCrossTrackMeters = 30.0m (Gating Threshold)", $fontLegend, $brushOrange, ($marginLeft + $plotW - 350), ($yGate - 18))

$g.DrawLine($penAxis, $marginLeft, $y2Bot, ($marginLeft + $plotW), $y2Bot)
$g.DrawLine($penAxis, $marginLeft, $y2Top, $marginLeft, $y2Bot)

for ($i = 0; $i -lt ($rows.Count - 1); $i++) {
    $x_a = Tx $rows[$i].timestamp
    $y_a = Ty2 $rows[$i].cross_track_m
    $x_b = Tx $rows[$i+1].timestamp
    $y_b = Ty2 $rows[$i+1].cross_track_m
    $g.DrawLine($penOrange, $x_a, $y_a, $x_b, $y_b)
}
$g.DrawString("2. Cross-Track Distance to Route Polyline & Gating Release", $fontSub, $brushBlack, ($marginLeft + 10), ($y2Top + 10))

# ----------------- SUBPLOT 3 -----------------
$y3Top = $marginTop + ($subH + $gap) * 2
$y3Bot = $y3Top + $subH
$g.FillRectangle($brushOutage, $ox1, $y3Top, ($ox2 - $ox1), $subH)

foreach ($v in @(0.0, 1.0)) {
    $y = Ty3 $v
    $g.DrawLine($penGrid, $marginLeft, $y, ($marginLeft + $plotW), $y)
    $lbl = if ($v -eq 1.0) { "1 (ON)" } else { "0 (OFF)" }
    $g.DrawString($lbl, $fontLabel, $brushGray, ($marginLeft - 55), ($y - 7))
}
$g.DrawLine($penAxis, $marginLeft, $y3Bot, ($marginLeft + $plotW), $y3Bot)
$g.DrawLine($penAxis, $marginLeft, $y3Top, $marginLeft, $y3Bot)

for ($i = 0; $i -lt ($rows.Count - 1); $i++) {
    $x_a = Tx $rows[$i].timestamp
    $y_gnss_a = Ty3 $rows[$i].gnss_delivered
    $x_b = Tx $rows[$i+1].timestamp
    $y_gnss_b = Ty3 $rows[$i+1].gnss_delivered
    $g.DrawLine($penGreen, $x_a, $y_gnss_a, $x_b, $y_gnss_b)

    $y_act_a = Ty3 $rows[$i].constraint_active
    $y_act_b = Ty3 $rows[$i+1].constraint_active
    $g.DrawLine($penBlackDash, $x_a, $y_act_a, $x_b, $y_act_b)
}
$g.DrawString("3. State Flags: GNSS Delivered (Green) vs Route Constraint Active (Black Dashed = 0)", $fontSub, $brushBlack, ($marginLeft + 10), ($y3Top + 10))

for ($sec = 0; $sec -le $maxT; $sec += 10) {
    $x = Tx $sec
    $g.DrawLine($penAxis, $x, $y3Bot, $x, ($y3Bot + 6))
    $g.DrawString("${sec}s", $fontLabel, $brushBlack, ($x - 12), ($y3Bot + 10))
}
$g.DrawString("Replay Virtual Time (seconds)", $fontSub, $brushBlack, ($marginLeft + $plotW/2 - 100), ($y3Bot + 32))

$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Host "Successfully rendered PNG plot to $pngPath"


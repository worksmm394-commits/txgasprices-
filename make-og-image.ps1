Add-Type -AssemblyName System.Drawing

$outPath = "C:\Users\mcbop\Desktop\txgasprices\output\og-image.png"
$cheapPrice = "3.458"
$cheapCity  = "Laredo"

$W = 1200
$H = 630

$bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

# Solid green background
$green = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0x1D, 0x9E, 0x75))
$g.FillRectangle($green, 0, 0, $W, $H)

# Subtle darker green accent bar at bottom
$darkGreen = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0x17, 0x7D, 0x5C))
$g.FillRectangle($darkGreen, 0, $H - 10, $W, 10)

$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$whiteTrans = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 255, 255, 255))

# Big brand wordmark
$fontBrand = New-Object System.Drawing.Font("Segoe UI", 88, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$brandText = "TXGasPrices.net"
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$brandRect = New-Object System.Drawing.RectangleF(0, 120, $W, 130)
$g.DrawString($brandText, $fontBrand, $white, $brandRect, $sf)

# Subtitle
$fontSub = New-Object System.Drawing.Font("Segoe UI", 36, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$subRect = New-Object System.Drawing.RectangleF(0, 250, $W, 60)
$g.DrawString("Live Texas Gas Prices", $fontSub, $whiteTrans, $subRect, $sf)

# Price pill (rounded white-outlined card)
$pillW = 760
$pillH = 170
$pillX = ($W - $pillW) / 2
$pillY = 360
$pillPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 24
$pillPath.AddArc([float]$pillX,[float]$pillY,[float]($r*2),[float]($r*2),180,90) | Out-Null
$pillPath.AddArc([float]($pillX + $pillW - $r*2),[float]$pillY,[float]($r*2),[float]($r*2),270,90) | Out-Null
$pillPath.AddArc([float]($pillX + $pillW - $r*2),[float]($pillY + $pillH - $r*2),[float]($r*2),[float]($r*2),0,90) | Out-Null
$pillPath.AddArc([float]$pillX,[float]($pillY + $pillH - $r*2),[float]($r*2),[float]($r*2),90,90) | Out-Null
$pillPath.CloseFigure()
$pen = New-Object System.Drawing.Pen($white, 3)
$g.DrawPath($pen, $pillPath)

# "Cheapest today in Texas" label (plain ASCII to avoid encoding issues)
$fontLabel = New-Object System.Drawing.Font("Segoe UI", 22, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$labelRect = New-Object System.Drawing.RectangleF([float]$pillX, [float]($pillY + 18), [float]$pillW, 30)
$g.DrawString("CHEAPEST TODAY IN TEXAS", $fontLabel, $whiteTrans, $labelRect, $sf)

# Big price value
$fontPrice = New-Object System.Drawing.Font("Segoe UI", 68, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$priceRect = New-Object System.Drawing.RectangleF([float]$pillX, [float]($pillY + 52), [float]$pillW, 70)
$g.DrawString("`$$cheapPrice/gal", $fontPrice, $white, $priceRect, $sf)

# City under price
$fontCity = New-Object System.Drawing.Font("Segoe UI", 22, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$cityRect = New-Object System.Drawing.RectangleF([float]$pillX, [float]($pillY + 125), [float]$pillW, 30)
$g.DrawString("Murphy USA in $cheapCity", $fontCity, $whiteTrans, $cityRect, $sf)

$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()

Write-Host "Wrote $outPath ($(((Get-Item $outPath).Length / 1KB).ToString('F1')) KB)"

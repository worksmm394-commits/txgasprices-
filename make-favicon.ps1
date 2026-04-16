Add-Type -AssemblyName System.Drawing

$outDir = "C:\Users\mcbop\Desktop\txgasprices\output"

function Create-FaviconPng {
    param([int]$size, [string]$path)

    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint  = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    # Background #1a1a18 with rounded corners
    $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0x1a, 0x1a, 0x18))
    $radius = [int]($size * 0.18)
    if ($size -le 16) { $radius = 2 }
    $path2 = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path2.AddArc(0, 0, $radius*2, $radius*2, 180, 90) | Out-Null
    $path2.AddArc($size - $radius*2, 0, $radius*2, $radius*2, 270, 90) | Out-Null
    $path2.AddArc($size - $radius*2, $size - $radius*2, $radius*2, $radius*2, 0, 90) | Out-Null
    $path2.AddArc(0, $size - $radius*2, $radius*2, $radius*2, 90, 90) | Out-Null
    $path2.CloseFigure()
    $g.FillPath($bg, $path2)

    # Green gas pump - drawn with primitives for reliable rendering
    $green = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0x4a, 0xd6, 0x6a))
    $greenPen = New-Object System.Drawing.Pen($green, [float]([Math]::Max(1, $size * 0.04)))

    # Scale factor: design is laid out on a 32-unit grid, centered in upper portion
    $s = $size / 32.0
    $cx = $size / 2.0

    # For tiny sizes, draw simplified shape
    if ($size -le 16) {
        # Simple pump silhouette: rectangle body + nozzle
        $bodyW = 7
        $bodyH = 8
        $bodyX = ($size - $bodyW) / 2.0
        $bodyY = 2
        $g.FillRectangle($green, [float]$bodyX, [float]$bodyY, [float]$bodyW, [float]$bodyH)
        # nozzle extension
        $g.FillRectangle($green, [float]($bodyX + $bodyW), [float]($bodyY + 2), [float]2, [float]3)
    } else {
        # Gas pump body (tank shape) - main rectangle
        $bodyX = $cx - ($s * 5)
        $bodyY = $s * 4
        $bodyW = $s * 9
        $bodyH = $s * 12

        # Body with rounded top
        $bodyPath = New-Object System.Drawing.Drawing2D.GraphicsPath
        $rBody = [Math]::Max(1, $s * 1.5)
        $bodyPath.AddArc([float]$bodyX, [float]$bodyY, [float]($rBody*2), [float]($rBody*2), 180, 90) | Out-Null
        $bodyPath.AddArc([float]($bodyX + $bodyW - $rBody*2), [float]$bodyY, [float]($rBody*2), [float]($rBody*2), 270, 90) | Out-Null
        $bodyPath.AddLine([float]($bodyX + $bodyW), [float]($bodyY + $bodyH), [float]$bodyX, [float]($bodyY + $bodyH)) | Out-Null
        $bodyPath.CloseFigure()
        $g.FillPath($green, $bodyPath)

        # Display/screen (dark rectangle on pump face)
        $scrX = $bodyX + ($s * 1.2)
        $scrY = $bodyY + ($s * 1.5)
        $scrW = $bodyW - ($s * 2.4)
        $scrH = $s * 2.5
        $g.FillRectangle($bg, [float]$scrX, [float]$scrY, [float]$scrW, [float]$scrH)

        # Base / pedestal
        $baseW = $bodyW + ($s * 1.5)
        $baseX = $cx - ($baseW / 2)
        $baseY = $bodyY + $bodyH
        $baseH = $s * 0.8
        $g.FillRectangle($green, [float]$baseX, [float]$baseY, [float]$baseW, [float]$baseH)

        # Nozzle/hose arm on right side
        $armX = $bodyX + $bodyW
        $armY = $bodyY + ($s * 3)
        $armW = $s * 2.5
        $armH = $s * 1.2
        $g.FillRectangle($green, [float]$armX, [float]$armY, [float]$armW, [float]$armH)

        # Nozzle tip going up
        $tipX = $armX + $armW - ($s * 1.2)
        $tipY = $bodyY + ($s * 1)
        $tipW = $s * 1.2
        $tipH = $s * 2
        $g.FillRectangle($green, [float]$tipX, [float]$tipY, [float]$tipW, [float]$tipH)
    }

    # "TX" text in white at bottom
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $txSize = if ($size -le 16) { [float]6 } else { [float]($size * 0.22) }
    $fontFamily = "Arial"
    $txFont = New-Object System.Drawing.Font($fontFamily, $txSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $txRectY = if ($size -le 16) { [float]($size - 6) } else { [float]($size * 0.78) }
    $txRectH = if ($size -le 16) { [float]6 } else { [float]($size * 0.22) }
    $txRect = New-Object System.Drawing.RectangleF([float]0, $txRectY, [float]$size, $txRectH)
    $g.DrawString("TX", $txFont, $white, $txRect, $fmt)

    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    Write-Host "Wrote $path"
}

function Create-Ico {
    param([string]$pngPath, [string]$icoPath, [int]$size)

    $pngBytes = [System.IO.File]::ReadAllBytes($pngPath)
    $pngLen = $pngBytes.Length

    $header = [byte[]]@(0, 0, 1, 0, 1, 0)
    $entry = New-Object byte[] 16
    $entry[0] = [byte]($size -band 0xFF)
    $entry[1] = [byte]($size -band 0xFF)
    $entry[2] = 0
    $entry[3] = 0
    # planes = 1 (little endian UInt16)
    $entry[4] = 1; $entry[5] = 0
    # bitcount = 32
    $entry[6] = 32; $entry[7] = 0
    # size (little endian UInt32)
    $sizeBytes = [BitConverter]::GetBytes([UInt32]$pngLen)
    for ($i = 0; $i -lt 4; $i++) { $entry[8 + $i] = $sizeBytes[$i] }
    # offset = 22
    $offsetBytes = [BitConverter]::GetBytes([UInt32]22)
    for ($i = 0; $i -lt 4; $i++) { $entry[12 + $i] = $offsetBytes[$i] }

    $all = New-Object byte[] ($header.Length + $entry.Length + $pngLen)
    [Array]::Copy($header, 0, $all, 0, $header.Length)
    [Array]::Copy($entry, 0, $all, $header.Length, $entry.Length)
    [Array]::Copy($pngBytes, 0, $all, $header.Length + $entry.Length, $pngLen)

    [System.IO.File]::WriteAllBytes($icoPath, $all)
    Write-Host "Wrote $icoPath ($pngLen bytes of PNG data)"
}

Create-FaviconPng -size 16  -path "$outDir\favicon-16x16.png"
Create-FaviconPng -size 32  -path "$outDir\favicon-32x32.png"
Create-FaviconPng -size 180 -path "$outDir\apple-touch-icon.png"
Create-Ico -pngPath "$outDir\favicon-32x32.png" -icoPath "$outDir\favicon.ico" -size 32

Write-Host "Done."

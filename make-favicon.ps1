Add-Type -AssemblyName System.Drawing

$outDir = "C:\Users\mcbop\Desktop\txgasprices\output"

function Create-FaviconPng {
    param([int]$size, [string]$path)

    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    # Solid green #1D9E75 - full bleed
    $green = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0x1D, 0x9E, 0x75))
    $g.FillRectangle($green, 0, 0, $size, $size)

    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)

    # Tiny sizes (<= 20px): render a simplified, chunky pump for legibility
    if ($size -le 20) {
        $s = $size / 16.0

        # Body: thick rectangle, filling center vertical
        $bx = [float](4 * $s); $by = [float](2 * $s)
        $bw = [float](6 * $s); $bh = [float](11 * $s)
        $g.FillRectangle($white, $bx, $by, $bw, $bh)

        # Base: wider horizontal strip under body
        $gx = [float](2 * $s); $gy = [float](13 * $s)
        $gw = [float](9 * $s); $gh = [float](1.5 * $s)
        $g.FillRectangle($white, $gx, $gy, $gw, $gh)

        # Nozzle arm extending right from body
        $ax = [float](10 * $s); $ay = [float](5 * $s)
        $aw = [float](3 * $s); $ah = [float](2 * $s)
        $g.FillRectangle($white, $ax, $ay, $aw, $ah)

        # Nozzle tip pointing up
        $tx = [float](11 * $s); $ty = [float](2.5 * $s)
        $tw = [float](2 * $s); $th = [float](3 * $s)
        $g.FillRectangle($white, $tx, $ty, $tw, $th)
    }
    else {
        # Full-detail pump on a 32-unit conceptual grid
        $s = $size / 32.0

        # Body (rounded rect)
        $bx = [float](8 * $s); $by = [float](4 * $s)
        $bw = [float](10 * $s); $bh = [float](18 * $s)
        $br = [float](2 * $s)
        $bodyPath = New-Object System.Drawing.Drawing2D.GraphicsPath
        $bodyPath.AddArc($bx, $by, $br*2, $br*2, 180, 90) | Out-Null
        $bodyPath.AddArc($bx + $bw - $br*2, $by, $br*2, $br*2, 270, 90) | Out-Null
        $bodyPath.AddArc($bx + $bw - $br*2, $by + $bh - $br*2, $br*2, $br*2, 0, 90) | Out-Null
        $bodyPath.AddArc($bx, $by + $bh - $br*2, $br*2, $br*2, 90, 90) | Out-Null
        $bodyPath.CloseFigure()
        $g.FillPath($white, $bodyPath)

        # Base / pedestal (a little wider than body)
        $px = [float](6 * $s); $py = [float](22 * $s)
        $pw = [float](14 * $s); $ph = [float](2.5 * $s)
        $g.FillRectangle($white, $px, $py, $pw, $ph)

        # Nozzle horizontal arm extending right
        $ax = [float](18 * $s); $ay = [float](9 * $s)
        $aw = [float](5.5 * $s); $ah = [float](3 * $s)
        $g.FillRectangle($white, $ax, $ay, $aw, $ah)

        # Nozzle vertical tip pointing up
        $tx = [float](20.5 * $s); $ty = [float](5.5 * $s)
        $tw = [float](3 * $s); $th = [float](4 * $s)
        $g.FillRectangle($white, $tx, $ty, $tw, $th)
    }

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
    $entry[4] = 1; $entry[5] = 0       # planes
    $entry[6] = 32; $entry[7] = 0      # bitcount
    $sizeBytes = [BitConverter]::GetBytes([UInt32]$pngLen)
    for ($i = 0; $i -lt 4; $i++) { $entry[8 + $i] = $sizeBytes[$i] }
    $offsetBytes = [BitConverter]::GetBytes([UInt32]22)
    for ($i = 0; $i -lt 4; $i++) { $entry[12 + $i] = $offsetBytes[$i] }

    $all = New-Object byte[] ($header.Length + $entry.Length + $pngLen)
    [Array]::Copy($header, 0, $all, 0, $header.Length)
    [Array]::Copy($entry, 0, $all, $header.Length, $entry.Length)
    [Array]::Copy($pngBytes, 0, $all, $header.Length + $entry.Length, $pngLen)

    [System.IO.File]::WriteAllBytes($icoPath, $all)
    Write-Host "Wrote $icoPath"
}

Create-FaviconPng -size 16  -path "$outDir\favicon-16x16.png"
Create-FaviconPng -size 32  -path "$outDir\favicon-32x32.png"
Create-FaviconPng -size 180 -path "$outDir\apple-touch-icon.png"
Create-Ico -pngPath "$outDir\favicon-32x32.png" -icoPath "$outDir\favicon.ico" -size 32

Write-Host "Done."

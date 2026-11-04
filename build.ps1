# Builds dist\YMStudio.exe with the C# compiler that ships with Windows. No SDK needed.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dist = Join-Path $root 'dist'
$lib = Join-Path $root 'lib'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$fx = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'

$sdkVersion = '1.0.4314.35'

New-Item -ItemType Directory -Force $dist | Out-Null

if (-not (Test-Path (Join-Path $lib 'WebView2Loader.dll'))) {
    Write-Host "Downloading WebView2 SDK $sdkVersion..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $work = Join-Path ([IO.Path]::GetTempPath()) ("ymstudio-sdk-" + [Guid]::NewGuid())
    New-Item -ItemType Directory -Force $work, $lib | Out-Null
    Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg" -OutFile "$work\sdk.zip" -UseBasicParsing
    Expand-Archive "$work\sdk.zip" "$work\sdk"
    Copy-Item "$work\sdk\lib\net462\Microsoft.Web.WebView2.Core.dll", "$work\sdk\lib\net462\Microsoft.Web.WebView2.WinForms.dll", "$work\sdk\runtimes\win-x64\native\WebView2Loader.dll" $lib
    Copy-Item "$work\sdk\LICENSE.txt" (Join-Path $lib 'WebView2-LICENSE.txt')
    Remove-Item -LiteralPath $work -Recurse -Force
}

$icon = Join-Path $root 'src\app.ico'
if (-not (Test-Path $icon)) {
    Add-Type -AssemblyName System.Drawing
    $size = 256
    $bmp = New-Object Drawing.Bitmap $size, $size
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $rect = New-Object Drawing.Rectangle 0, 0, $size, $size
    $brush = New-Object Drawing.Drawing2D.LinearGradientBrush $rect, ([Drawing.Color]::FromArgb(255, 124, 92, 255)), ([Drawing.Color]::FromArgb(255, 255, 43, 150)), 45
    $g.FillEllipse($brush, 6, 6, 244, 244)
    $white = New-Object Drawing.SolidBrush ([Drawing.Color]::White)
    foreach ($bar in @(@(62, 110, 78), @(100, 72, 154), @(138, 92, 114), @(176, 124, 50))) {
        $g.FillRectangle($white, $bar[0], $bar[1], 20, $bar[2])
    }
    $g.Dispose()
    $png = New-Object IO.MemoryStream
    $bmp.Save($png, [Drawing.Imaging.ImageFormat]::Png)
    $bytes = $png.ToArray()
    $out = [IO.File]::Create($icon)
    $w = New-Object IO.BinaryWriter $out
    $w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]1)
    $w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0)
    $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$bytes.Length); $w.Write([UInt32]22)
    $w.Write($bytes)
    $w.Close()
}

& $csc /nologo /target:winexe /platform:x64 /optimize+ /out:"$dist\YMStudio.exe" /win32icon:"$icon" `
    /r:"$lib\Microsoft.Web.WebView2.Core.dll" /r:"$lib\Microsoft.Web.WebView2.WinForms.dll" `
    /r:"$fx\System.Windows.Forms.dll" /r:"$fx\System.Drawing.dll" /r:"$fx\System.Web.Extensions.dll" `
    "$root\src\Program.cs"
if ($LASTEXITCODE -ne 0) { throw "csc exited with $LASTEXITCODE" }

Copy-Item "$lib\*.dll" $dist -Force
Copy-Item "$root\src\mod.js" $dist -Force
Copy-Item "$root\LICENSE" $dist -Force
if (Test-Path "$lib\WebView2-LICENSE.txt") { Copy-Item "$lib\WebView2-LICENSE.txt" $dist -Force }
Write-Host "OK: $dist\YMStudio.exe"

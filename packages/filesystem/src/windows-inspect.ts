/** Executed in a child PowerShell only; never activates an app, reads the clipboard, or changes user settings. */
export const windowsInspect = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Initialize-WinRT {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $script:operationTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq ('IAsyncOperation' + [char]96 + '1') } | Select-Object -First 1
  $script:actionTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
  [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapTransform,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapPixelFormat,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapAlphaMode,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.ExifOrientationMode,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.ColorManagementMode,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
}
function Await-Operation($operation, [Type]$type) {
  $task = $script:operationTask.MakeGenericMethod($type).Invoke($null, @($operation))
  $task.Wait()
  return $task.Result
}
function Await-Action($operation) {
  $task = $script:actionTask.Invoke($null, @($operation)); $task.Wait()
}
function Read-Ocr($stream) {
  $decoder = Await-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
  $scale = [Math]::Min(1.0, 2000.0/[Math]::Max($decoder.PixelWidth,$decoder.PixelHeight))
  $transform.ScaledWidth = [uint32][Math]::Max(1,[int]($decoder.PixelWidth*$scale))
  $transform.ScaledHeight = [uint32][Math]::Max(1,[int]($decoder.PixelHeight*$scale))
  $bitmap = Await-Operation ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore,$transform,[Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,[Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  try {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) { throw 'Windows OCR has no installed recognition language.' }
    $result = Await-Operation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    return $result.Text
  } finally { $bitmap.Dispose() }
}
try {
  $request = [IO.File]::ReadAllText($env:AFO_INSPECT_INPUT, [Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($request.kind -eq 'pdf') {
    Initialize-WinRT
    [Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf,ContentType=WindowsRuntime] | Out-Null
    [Windows.Data.Pdf.PdfPageRenderOptions,Windows.Data.Pdf,ContentType=WindowsRuntime] | Out-Null
    $file = Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($request.path)) ([Windows.Storage.StorageFile])
    $document = Await-Operation ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
    $parts = @(); $count = [Math]::Min(6, $document.PageCount)
    for ($i = 0; $i -lt $count; $i++) {
      $page = $document.GetPage($i)
      $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
      try {
        $render = New-Object Windows.Data.Pdf.PdfPageRenderOptions
        $scale = [Math]::Min(1500.0/$page.Size.Width,1500.0/$page.Size.Height)
        $render.DestinationWidth = [uint32][Math]::Max(1,[int]($page.Size.Width*$scale))
        $render.DestinationHeight = [uint32][Math]::Max(1,[int]($page.Size.Height*$scale))
        Await-Action ($page.RenderToStreamAsync($stream,$render))
        $stream.Seek(0)
        $parts += Read-Ocr $stream
      } finally { $stream.Dispose(); $page.Dispose() }
    }
    @{ text = ($parts -join [Environment]::NewLine); method = 'windows-pdf-ocr'; limited = ($document.PageCount -gt 6); pages = $count } | ConvertTo-Json -Depth 5 -Compress
  } else {
    Add-Type -AssemblyName System.Drawing
    $image = [Drawing.Image]::FromFile($request.path)
    $bitmap = $null; $small = $null; $graphics = $null
    try {
      if ([double]$image.Width * $image.Height -gt 80000000) { throw 'Image exceeds the 80 MP analysis limit.' }
      try {
        $orientation = [BitConverter]::ToUInt16($image.GetPropertyItem(274).Value, 0)
        $rotation = @{ 2=4; 3=2; 4=6; 5=5; 6=1; 7=7; 8=3 }
        if ($rotation.ContainsKey([int]$orientation)) { $image.RotateFlip([Drawing.RotateFlipType]$rotation[[int]$orientation]) }
      } catch {}
      $bitmap = New-Object Drawing.Bitmap($image)
      $small = New-Object Drawing.Bitmap(9, 8)
      $graphics = [Drawing.Graphics]::FromImage($small)
      $graphics.Clear([Drawing.Color]::White)
      $graphics.DrawImage($bitmap, 0, 0, 9, 8)
      $grays = @(); $colors = @(0.0,0.0,0.0)
      for ($y = 0; $y -lt 8; $y++) { for ($x = 0; $x -lt 9; $x++) {
        $p = $small.GetPixel($x,$y); $grays += (0.299*$p.R + 0.587*$p.G + 0.114*$p.B)
        if ($x -lt 8) { $colors[0] += $p.R; $colors[1] += $p.G; $colors[2] += $p.B }
      } }
      $bits = ''; $values = @()
      for ($y = 0; $y -lt 8; $y++) { for ($x = 0; $x -lt 8; $x++) {
        $bits += $(if ($grays[$y*9+$x] -gt $grays[$y*9+$x+1]) { '1' } else { '0' }); $values += $grays[$y*9+$x]
      } }
      $mean = ($values | Measure-Object -Average).Average; $variance = 0.0; $averageBits = ''
      foreach ($value in $values) { $averageBits += $(if ($value -ge $mean) { '1' } else { '0' }); $variance += [Math]::Pow($value-$mean,2) }
      $result = @{ width=$bitmap.Width; height=$bitmap.Height; hash=[Convert]::ToUInt64($bits,2).ToString('x16'); averageHash=[Convert]::ToUInt64($averageBits,2).ToString('x16');
        variance=$variance/64; color=@(($colors[0]/64),($colors[1]/64),($colors[2]/64)); text=''; method='windows-gdi' }
      $scale = [Math]::Min(360.0/$bitmap.Width,360.0/$bitmap.Height)
      $thumb = New-Object Drawing.Bitmap($bitmap, (New-Object Drawing.Size([Math]::Max(1,[int]($scale*$bitmap.Width)),[Math]::Max(1,[int]($scale*$bitmap.Height)))))
      $memory = New-Object IO.MemoryStream
      try { $thumb.Save($memory,[Drawing.Imaging.ImageFormat]::Jpeg); if ($memory.Length -le 29000) { $result.thumbnail='data:image/jpeg;base64,'+[Convert]::ToBase64String($memory.ToArray()) } }
      finally { $thumb.Dispose(); $memory.Dispose() }
      if ($request.ocr) {
        try {
        Initialize-WinRT
        $file = Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($request.path)) ([Windows.Storage.StorageFile])
        $stream = Await-Operation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        try { $result.text=Read-Ocr $stream; $result.method='windows-ocr' } finally { $stream.Dispose() }
        } catch { $result.ocrError=$_.Exception.Message }
      }
      $result | ConvertTo-Json -Depth 5 -Compress
    } finally { if ($graphics) { $graphics.Dispose() }; if ($small) { $small.Dispose() }; if ($bitmap) { $bitmap.Dispose() }; $image.Dispose() }
  }
} catch { @{error=$_.Exception.Message} | ConvertTo-Json -Compress; exit 1 }
`;

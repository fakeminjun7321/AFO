# AFO 설치(Windows PowerShell): irm https://raw.githubusercontent.com/fakeminjun7321/AFO/main/install.ps1 | iex
# GitHub Releases의 실행 파일을 받아 SHA256SUMS와 대조한 뒤 %LOCALAPPDATA%\Programs\AFO\afo.exe에 두고 사용자 PATH에 추가합니다.
# Node.js는 필요 없습니다. 환경 변수: AFO_VERSION(기본 최신), AFO_INSTALL, AFO_NO_MODIFY_PATH=1, AFO_DOWNLOAD_BASE(검증용)
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $repo = 'fakeminjun7321/AFO'
  $installDir = if ($env:AFO_INSTALL) { $env:AFO_INSTALL } else { Join-Path $env:LOCALAPPDATA 'Programs\AFO' }

  if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'AFO 설치 오류: 이 스크립트는 Windows용입니다. macOS는 install.sh를 사용하세요.' }
  # Windows on Arm도 x64 에뮬레이션으로 실행합니다.
  if (-not [Environment]::Is64BitOperatingSystem) { throw 'AFO 설치 오류: 64비트 Windows가 필요합니다.' }

  $base = if ($env:AFO_DOWNLOAD_BASE) { $env:AFO_DOWNLOAD_BASE }
    elseif ($env:AFO_VERSION) { "https://github.com/$repo/releases/download/v$($env:AFO_VERSION.TrimStart('v'))" }
    else { "https://github.com/$repo/releases/latest/download" }
  $archive = 'afo-win-x64.zip'
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("afo-install-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host "AFO 내려받는 중: $archive"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$archive" -OutFile (Join-Path $tmp $archive)
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS')
    $expected = $null
    foreach ($line in Get-Content (Join-Path $tmp 'SHA256SUMS')) {
      if ($line -match "^([0-9a-f]{64})  $([regex]::Escape($archive))$") { $expected = $Matches[1]; break }
    }
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $archive)).Hash.ToLowerInvariant()
    if (-not $expected -or $expected -ne $actual) { throw 'AFO 설치 오류: 받은 파일의 SHA-256이 SHA256SUMS와 다릅니다. 설치하지 않았습니다.' }

    Expand-Archive -Path (Join-Path $tmp $archive) -DestinationPath (Join-Path $tmp 'x')
    $exe = Join-Path $tmp 'x\afo.exe'
    & $exe --version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'AFO 설치 오류: 받은 afo.exe를 실행할 수 없습니다. 설치하지 않았습니다.' }
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    Move-Item -Force $exe (Join-Path $installDir 'afo.exe')
    Write-Host "설치 완료: $(& (Join-Path $installDir 'afo.exe') --version) -> $installDir\afo.exe"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($userPath -split ';' | Where-Object { $_ })
  if ($parts -contains $installDir) { Write-Host '이제 afo 를 입력하세요.'; return }
  if ($env:AFO_NO_MODIFY_PATH -eq '1') { Write-Host "PATH에 $installDir 를 추가하면 afo 를 바로 쓸 수 있습니다."; return }
  [Environment]::SetEnvironmentVariable('Path', (($parts + $installDir) -join ';'), 'User')
  $env:Path = "$env:Path;$installDir"
  Write-Host '사용자 PATH에 추가했습니다. 이 창에서 바로, 또는 새 터미널에서 afo 를 입력하세요.'
}

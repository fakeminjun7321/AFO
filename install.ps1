# AFO 설치(Windows PowerShell): irm https://raw.githubusercontent.com/fakeminjun7321/AFO/main/install.ps1 | iex
# GitHub Releases의 실행 파일을 받아 SHA256SUMS와 대조한 뒤 %LOCALAPPDATA%\Programs\AFO\afo.exe에 두고 사용자 PATH에 추가합니다.
# 탐색기 보내기 메뉴 "AFO로 정리"(%APPDATA%\Microsoft\Windows\SendTo\AFO로 정리.lnk → afo.exe gui --exit-when-closed <폴더>)도 만듭니다.
# Node.js는 필요 없습니다. 환경 변수: AFO_VERSION(기본 최신), AFO_INSTALL, AFO_NO_MODIFY_PATH=1, AFO_NO_SENDTO=1(보내기 메뉴를 만들지 않음),
# AFO_DOWNLOAD_BASE(검증용)
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

  # 보내기 메뉴: 탐색기가 선택한 폴더 경로를 인수 끝에 붙입니다. 화면을 닫으면 afo도 끝납니다(--exit-when-closed).
  # 설명(Description)에 표식이 있는, AFO가 만든 바로 가기만 덮어씁니다.
  if ($env:AFO_NO_SENDTO -eq '1') { Write-Host '보내기 메뉴는 만들지 않았습니다(AFO_NO_SENDTO=1).' }
  else {
    try {
      $marker = 'AFO install.ps1: afo gui'
      $sendTo = Join-Path $env:APPDATA 'Microsoft\Windows\SendTo'
      $lnkPath = Join-Path $sendTo 'AFO로 정리.lnk'
      # WScript.Shell은 시스템 코드 페이지 밖의 글자(한글)가 든 경로를 읽고 쓰지 못합니다: ASCII 이름으로 다룬 뒤 PowerShell로 옮깁니다.
      $asciiLnk = Join-Path $sendTo 'afo-sendto.tmp.lnk'
      $shell = New-Object -ComObject WScript.Shell
      $foreign = $false
      if (Test-Path -LiteralPath $lnkPath) {
        Copy-Item -LiteralPath $lnkPath -Destination $asciiLnk -Force
        $foreign = $shell.CreateShortcut($asciiLnk).Description -ne $marker
        Remove-Item -LiteralPath $asciiLnk -Force
      }
      if ($foreign) {
        Write-Host "보내기 메뉴를 만들지 않았습니다: $lnkPath 가 이미 있고 AFO가 만든 것이 아닙니다."
      } else {
        New-Item -ItemType Directory -Force -Path $sendTo | Out-Null
        $lnk = $shell.CreateShortcut($asciiLnk)
        $lnk.TargetPath = Join-Path $installDir 'afo.exe'
        $lnk.Arguments = 'gui --exit-when-closed'
        $lnk.WorkingDirectory = $installDir
        $lnk.Description = $marker
        $lnk.WindowStyle = 7
        $lnk.Save()
        Move-Item -LiteralPath $asciiLnk -Destination $lnkPath -Force
        Write-Host '탐색기 보내기 메뉴를 만들었습니다: 폴더를 오른쪽 클릭 -> 보내기 -> AFO로 정리'
      }
    } catch { Write-Host "보내기 메뉴를 만들지 못했습니다: $($_.Exception.Message)" }
  }

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($userPath -split ';' | Where-Object { $_ })
  if ($parts -contains $installDir) { Write-Host '이제 afo 를 입력하세요.'; return }
  if ($env:AFO_NO_MODIFY_PATH -eq '1') { Write-Host "PATH에 $installDir 를 추가하면 afo 를 바로 쓸 수 있습니다."; return }
  [Environment]::SetEnvironmentVariable('Path', (($parts + $installDir) -join ';'), 'User')
  $env:Path = "$env:Path;$installDir"
  Write-Host '사용자 PATH에 추가했습니다. 이 창에서 바로, 또는 새 터미널에서 afo 를 입력하세요.'
}

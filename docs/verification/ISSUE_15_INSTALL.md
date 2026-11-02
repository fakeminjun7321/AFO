# #15 curl/PowerShell 설치와 단일 실행 파일 검증

상태: **구현자 검증 기록**(독립 verifier 검증 전). 2026-11-02. #15 가운데 "CLI 배포·실행 안내" 부분만 다룹니다. 출품 URL 인정 여부(#2)는 범위 밖입니다.

## 구현

- `scripts/release/build-binaries.mjs`: `apps/cli/src/sea.ts`를 esbuild로 CommonJS 한 파일로 묶고, 같은 Node 버전으로 SEA blob을 만들어 nodejs.org의 공식 Node 바이너리(SHASUMS256.txt 대조)에 postject로 넣습니다. macOS는 서명을 지운 뒤 ad-hoc `codesign`. 결과: `afo-darwin-arm64.tar.gz`, `afo-darwin-x64.tar.gz`, `afo-win-x64.zip`, `SHA256SUMS`(각 압축에 `LICENSE`·`LICENSE-node`·`LICENSE-zod` 포함).
- `install.sh`(macOS)·`install.ps1`(Windows): Releases에서 받기 → `SHA256SUMS` 대조(다르면 설치 안 함) → 압축 해제 → `--version` 실행 확인 → 설치 → PATH 추가(이미 있으면 다시 쓰지 않음).
- `apps/cli/src/index.ts`: 프로세스 진입 코드를 `main()`으로 내보내고 `--version`을 추가. 묶은 파일에서는 `import.meta.url`이 없어 `isEntryPoint()`가 false이고 `sea.ts`만 `main()`을 부릅니다.
- `.github/workflows/release.yml`: `v*` 태그에서 빌드 → macOS arm64·Intel·Windows(PowerShell 5.1)에서 설치 스크립트로 설치·미리보기 → Release 생성. PR에서는 설치 확인까지만.

## 검증 보고

```text
Issue / PR / Commit: #15 / feat/curl-install
Environment: macOS 27.0.1 (26A434) arm64, 실물 Mac, Node v24.18.0
Fixture and baseline manifest: scratchpad temp 폴더의 합성 파일 6개(한글·공백 이름, 같은 내용 사본 1쌍, 확장자 없음 1개), 설치용 HOME과 AFO_STATE_DIR도 temp
Steps or exact commands:
  npm test
  node scripts/release/build-binaries.mjs --targets darwin-arm64,win-x64
  python3 -m http.server(127.0.0.1) + AFO_DOWNLOAD_BASE로 install.sh 실행(HOME=temp, SHELL=/bin/zsh)
  설치한 afo로 --version, preview, plan --json, apply --mode organize --confirm, runs --json, undo --confirm
  SHA256SUMS를 틀린 값으로 바꾼 서버로 install.sh 실행
Observed:
  npm test: tests 495 / pass 484 / fail 0 / skipped 11
  빌드: afo-darwin-arm64.tar.gz 36.7 MiB, afo-win-x64.zip 33.2 MiB; 빌드 중 arm64 실행 파일의 --version = "afo 0.1.0"
  install.sh: 종료 0, ~/.afo/bin/afo 설치, .zshrc에 PATH 한 줄(두 번째 설치에서도 1줄); 설치 파일 xattr에 com.apple.quarantine 없음, codesign Signature=adhoc
  apply: 이동 5 / 실패 0, 전후 내용 해시 6개 동일; undo: 되돌림 5, 새로 만든 빈 폴더 4개 제거, 원래 목록과 동일
  틀린 SHA256SUMS: "SHA-256이 SHA256SUMS와 다릅니다" 종료 1, 설치 폴더 생성 안 함
Passed / Failed / Not run: 위 항목 PASS. Windows 실행·install.ps1·darwin-x64는 이 Mac에서 Not run
Verification level: Physical-device-verified(macOS arm64, 합성 파일) / Windows·Intel Mac은 PR의 release.yml(VM)에서 확인 예정
Not verified and reason: Windows 실물 PC(기기 없음), Intel Mac 실물, GitHub Releases의 실제 다운로드(첫 릴리스 전), SmartScreen·백신 반응
```

## 한계

- 실행 파일은 코드 서명·공증이 없습니다. curl·PowerShell로 받으면 macOS 격리 표시나 Windows Mark-of-the-Web이 붙지 않아 실행되지만, 브라우저로 받은 파일은 Gatekeeper·SmartScreen이 막을 수 있습니다. 서명된 빌드라고 부르지 않습니다.
- Windows 실행 파일은 postject가 Node의 Authenticode 서명을 깨뜨립니다(빌드 중 "signature seems corrupted" 경고). 실행에는 영향이 없지만 서명 검사 도구는 손상된 서명으로 봅니다.
- Linux용 실행 파일은 만들지 않습니다(지원 OS가 아님). 설치 스크립트는 macOS 밖에서 안내 후 종료합니다.

# #3 OS 파일 작업 어댑터·ADR 0001 독립 검증

역할: verifier. 날짜: 2026-10-26. 범위: `packages/filesystem/src/platform.ts`, `tests/platform.test.ts`, `docs/adr/0001-cli-file-operations.md`.
Windows 실물·Electron 측정은 이번 검증 범위 밖입니다. 제품 코드는 수정하지 않았습니다.

```text
Issue / PR / Commit: #3 / PR 없음 / 대상 52c7d4a (기능 64382a5 + 휴지통 env 게이트), 기준 main 1a82982. 검증 테스트는 브랜치 verify-3에 추가
Environment: macOS 27.0.1 (26A434), arm64, Node v24.18.0, physical(이 Mac 1대). Windows: 미검증(CI 대기)
Fixture and baseline manifest: 각 테스트가 mkdtemp(<tmp>/afo-test-v3-*)로 만든 합성 폴더. 검증자 자체 oracle snap()이
  경로·종류·size·mtimeNs·dev·ino·nlink·sha256(일반 파일), 링크 대상(readlink, 따라가지 않음), FIFO는 열지 않고 'other'로 기록. 전후 대조
Steps or exact commands:
  npm ci --ignore-scripts --no-audit --no-fund
  npm run typecheck                         (exit 0)
  npm test                                  (verify-3 추가 전: 40 tests / 39 pass / 0 fail / 1 skip)
  npm test                                  (verify-3 추가 후: 52 tests / 50 pass / 0 fail / 2 skip, exit 0)
  node --test dist/tests/verify-3.test.js   (12 tests / 11 pass / 0 fail / 1 skip[V3-12])
  AFO_REAL_TRASH_TEST=1 node --test --test-name-pattern='V3-12' dist/tests/verify-3.test.js
                                            (2 tests / 2 pass: V3-12 + 이름에 'V3-12'가 들어간 V3-06. 실제 휴지통 이동은 1회)
  /usr/bin/trash <scratchpad>/afo-test-trashprobe/does-not-exist.txt   (exit 5, NSCocoaErrorDomain Code=4)
Observed files / hashes / journal / exit status: 아래 표. journal은 이 범위에 구현되지 않음(검사 대상 아님)
Passed / Failed / Not run: 아래 표
Verification level: Unit-verified + Physical-device-verified(macOS 이 Mac, 어댑터 단위). Windows·서비스 경로는 미검증
Not verified and reason: 아래 "검증하지 못한 것"
Release blocker and unblock condition: 데이터 손실·덮어쓰기는 관측되지 않음. ADR의 CI 휴지통 실행 주장(F-1)은 문서 또는 workflow 수정 전까지 FAIL
```

전체 `AFO_REAL_TRASH_TEST=1 node --test dist/tests/verify-3.test.js` 대신 `--test-name-pattern='V3-12'`로 실행했습니다. 실제 휴지통 사례는 V3-12뿐이며 다른 사례는 env와 무관하게 휴지통 도구를 호출하지 않습니다. 사용자 휴지통에 합성 파일을 한 번만 보내기 위한 선택입니다.

## 독립 사례 결과 (`tests/verify-3.test.ts`, 이 Mac 실제 파일시스템)

| ID | 사례 | 결과 | 관측 |
| --- | --- | --- | --- |
| V3-01 | 상대·빈 경로: move src/dst, trash, delete, fileIdentity, sameVolume | PASS | 모두 `NOT_SUPPORTED`. 폴더 manifest 동일, cwd에 파일 생성 없음 |
| V3-02 | 목적지가 기존 파일 / 기존 폴더 / src와 같은 경로 / 끊어진 링크 | PASS | 모두 `DEST_EXISTS`. 원본·목적지 sha256 동일, 링크 대상 미생성 |
| V3-03 | 대소문자만 다른 이름(`REPORT.TXT`↔`report.txt`, 같은 폴더 `Report`→`report`), NFC↔NFD 같은 이름 | PASS | tmpdir이 대소문자·정규화 무시 APFS로 관측됨. 모두 `DEST_EXISTS`, 해시 보존 |
| V3-04 | 목적지 부모가 루트 안 링크 / 밖 링크 / 상대 링크 / 일반 파일 | PASS | 모두 `LINK_REJECTED`, manifest 동일 |
| V3-05 | 원본이 파일 링크 / 폴더 링크 / 하드링크 양쪽 이름 / 폴더 / FIFO | PASS | 링크·하드링크 `LINK_REJECTED`, 폴더·FIFO `NOT_SUPPORTED`. nlink 2 유지, manifest 동일 |
| V3-06 | `expected` 뒤 size 변경, 같은 size의 mtime 변경(utimes), 같은 이름 다른 inode로 교체 | PASS | move·delete 모두 `FILE_CHANGED`, manifest 동일 |
| V3-07 | 정상 이동 | PASS | dev/ino/size/mtimeNs 동일, nlink 1, 원본 부재, manifest는 해당 이름 변경만 차이 |
| V3-08 | `한글 파일 😀 v2.txt` NFC·NFD 각각 이동 | PASS | 내용 해시 보존, 원래 폴더 비어 있음. readdir이 NFC/NFD 저장 형태를 그대로 반환 |
| V3-09 | delete가 폴더 / 빈 폴더 / 파일 링크 / 폴더 링크 / 끊어진 링크 / 하드링크 / 없는 파일 거부 | PASS | `NOT_SUPPORTED`×2, `LINK_REJECTED`×4, `SOURCE_MISSING`. 링크 대상 해시 보존. 지정 파일 1개만 삭제 |
| V3-10 | `freeSpace` | PASS | 폴더·파일 경로는 0 이상 safe integer, 없는 경로·상대·빈 문자열은 `null` |
| V3-11 | 목적지의 조부모 경로에 링크(`work/hop -> elsewhere`) | 관측(한계) | **어댑터가 링크를 통과해 이동함**(`moved-through-link`). 내용은 정확히 1개 존재, 손실 없음. ADR 결정 3이 서비스 책임으로 명시한 한계와 일치 |
| V3-12 | 실제 OS 휴지통(`AFO_REAL_TRASH_TEST=1`, 1회) | PASS | 없는 경로 `SOURCE_MISSING`, 폴더 `NOT_SUPPORTED`, 링크 `LINK_REJECTED`(모두 도구 호출 전 거부, manifest 동일). 합성 파일 `afo-test-verify3-<hex>.txt` 1개만 사라지고 형제 파일·폴더·링크 보존. `~/.Trash/<같은 이름>` size 32 존재 |

## 완료 조건별 판정 (#3)

| 완료 조건 | 판정 | 근거 |
| --- | --- | --- |
| Electron/TS 우선안과 Tauri 대안 비교, 실제 설치 버전·근거 ADR | NOT-RUN(범위 밖) / 부분 | 비교 표와 이유는 있음. Electron/Tauri는 설치·측정하지 않았고 ADR도 그렇게 적음 |
| 두 OS 합성 폴더: 선택·스캔·이동·휴지통·영구 삭제·재시작 | 부분 | macOS 어댑터 단위로 이동·휴지통·영구 삭제·스캔 PASS. 재시작 후 결과·Windows는 미검증 |
| no-clobber 이동, 동일 볼륨, junction/reparse·symlink·하드링크 식별, 승인 직후 변경 보장 범위 | macOS PASS / Windows NOT-RUN | V3-02~V3-07, builder 교차 볼륨 테스트(`/System/Volumes/VM` 비교) 재실행 확인. junction/reparse는 Windows 미검증. 조부모 링크는 V3-11 한계 |
| 휴지통 복원 한계, 여유 공간 관측, journal 위치·지속성·루트 잠금 결정 | 부분 | 결정은 기록됨. journal·잠금은 미구현(ADR이 명시). Finder 복원 실물 확인 없음 |
| 지원 OS/CPU 최소 범위, 패키징·서명, Electron 메모리/배포 크기와 스캔 기준값 | 부분 / NOT-RUN | 스캔 1회 측정만 있음. OS/CPU·서명은 ADR이 "미결정"으로 정직하게 표기 |
| 검증하지 못한 기능을 성공으로 처리하지 않음 | **FAIL(F-1)** | 대부분 미검증으로 표기했으나 CI 휴지통 실행 주장이 사실과 다름 |

## ADR 0001 사실 주장 대조

| 주장 | 판정 | 대조 결과 |
| --- | --- | --- |
| macOS 27.0.1 (26A434), arm64, Node v24.18.0, `/usr/bin/trash` root:wheel 실행 가능 | PASS | `sw_vers`, `uname -m`, `node -v`, `ls -l /usr/bin/trash` 일치 |
| 없는 파일에 trash 도구 종료 코드 5, `NSCocoaErrorDomain Code=4` | PASS | 합성 경로로 재현 |
| 휴지통 파일이 `~/.Trash/`에 같은 이름·크기로 존재 | PASS | V3-12에서 lstat으로 재현(size 32) |
| 이동 후 원본 부재, sha256·dev/ino 동일, nlink 1 / 기존 목적지 `DEST_EXISTS`와 manifest 보존 | PASS | V3-02, V3-07 |
| `/System/Volumes/VM`(다른 dev)로 쓰기 전 `CROSS_VOLUME`, 실제 EXDEV 경로 미검증 | PASS | builder 테스트 재실행 시 "compared against /System/Volumes/VM". 미검증 표기 정확 |
| nlink 2 원본은 다시 이동·삭제하지 않음 | PASS | V3-05, V3-09 |
| 부모 경로 중간 링크 교체는 서비스가 막아야 함(어댑터 한계) | PASS(정확한 한계 기술) | V3-11에서 실제로 어댑터가 막지 않음을 관측. #10 서비스의 필수 검사 |
| sha256 재해시는 서비스 담당 | PASS(한계 기술) | 어댑터는 dev/ino/size/mtimeNs만 비교. 같은 size·복원된 mtime의 내용 변경은 어댑터가 못 잡음(테스트하지 않음, 코드 확인) |
| 영구 삭제 전후 `bavail*bsize`가 1,048,576 바이트 증가(두 차례 모두) | NOTE | 이 검증의 실행에서는 1,052,672(1 MiB + 4 KiB). ADR이 정확한 회수량이 아니라고 적었으므로 FAIL은 아님. "두 차례 모두 동일"은 재현되지 않는 관측값임 |
| scanFolder 1,000개 44.4 ms / 43.0 ms, rss 85.7 MiB | PASS(근사 재현) | 이번 실행 42.9 ms, rss 84.5 MiB. 1회 측정이라는 표기 정확 |
| "CI에서는 `AFO_REAL_TRASH_TEST=1`로 실행합니다" | **FAIL(F-1)** | `.github/workflows/engine.yml`의 `npm test` 단계에 이 환경변수가 없음. CI의 macOS·Windows 모두 휴지통 테스트를 건너뜀 |
| Windows 전 항목 "구현만, 미검증(CI 대기)" | 주의 | 표기는 정직하나 F-1 때문에 Windows PowerShell 휴지통은 현재 CI 구성으로는 실행되지 않음 |

## 발견 결함

- **F-1 (문서 사실 불일치, 제품 코드 결함 아님)**: ADR 결정 4의 "CI에서는 `AFO_REAL_TRASH_TEST=1`로 실행합니다"가 사실이 아닙니다.
  재현: `grep -rn AFO_REAL_TRASH_TEST .github/` → 결과 없음. `engine.yml`은 `npm test`만 실행하고 `tests/platform.test.ts`는 env가 `'1'`이 아니면 skip합니다.
  해제 조건: workflow에 env를 추가해 hosted runner 결과를 확인하거나, ADR을 "CI에서도 현재 건너뜀"으로 고칩니다(builder/coordinator 담당).
- **O-1 (관측된 한계, #10 위험)**: 목적지의 조부모 이상 경로에 있는 링크는 어댑터가 거부하지 않습니다(V3-11). 루트 밖 링크라면 루트 이탈 이동이 됩니다. ADR이 서비스 책임으로 명시했으므로 이번 FAIL은 아니며, #10에서 realpath·전체 부모 검사의 부정 테스트가 필요합니다.
- **O-2 (분류, 테스트하지 않음)**: `EPERM`을 `NOT_SUPPORTED`로 매핑합니다. macOS의 잠긴 파일(`uchg`)·SIP 경로 같은 권한 실패가 `PERMISSION_DENIED`가 아닌 `NOT_SUPPORTED`로 보고될 수 있습니다. 데이터 안전 문제는 아닙니다.

## 검증하지 못한 것

- Windows 전체(link no-clobber, junction·reparse, PowerShell 휴지통, statfs). 이 Mac에서 검증 불가, F-1 때문에 CI 휴지통도 미실행
- 휴지통 도구 자체의 실패 경로(`TRASH_FAILED`)를 실제로 유발하는 사례. 휴지통 실제 호출을 1회로 제한해 시도하지 않음
- Finder "되돌려 놓기" 복원, 재시작 후 결과, 실제 두 번째 쓰기 가능 볼륨의 `EXDEV`, exFAT/FAT 하드링크 미지원
- journal·잠금·상태 폴더(미구현), Electron/Tauri 측정(범위 밖)
- 휴지통에 남은 합성 파일 1개(`~/.Trash/afo-test-verify3-<hex>.txt`)는 규칙상 비우지 않았습니다

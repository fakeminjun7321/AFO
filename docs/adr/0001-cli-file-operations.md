# ADR 0001: CLI 파일 작업 어댑터와 플랫폼 결정

- 상태: 제안(#3 일부). 2026-10-26, 기준 commit `1a82982`. 사람 검토·병합 전입니다.
- 범위: Node.js CLI가 쓸 OS 파일 작업 어댑터 `packages/filesystem/src/platform.ts`와 이 Mac의 실측. 승인·저널·잠금 서비스(#8/#10–#13)는 이 ADR의 결정을 따르는 후속 구현입니다.
- 검증 수준: macOS는 **실제 하드웨어 1대(이 Mac)** 의 합성 temp 폴더 결과입니다. **Windows: 구현만, 미검증(CI 대기)**. Linux는 지원 대상이 아니며 휴지통은 `NOT_SUPPORTED`입니다.

## 실제 환경

| 항목 | 관측값 |
| --- | --- |
| OS | macOS 27.0.1 (build 26A434), `sw_vers` |
| CPU | arm64 (`uname -m`) |
| Node.js | v24.18.0 (`node -v`), `package.json` engines `>=24 <25` |
| 휴지통 도구 | `/usr/bin/trash` 존재(root:wheel, 실행 가능). `trash [-v] [-s] file...` |
| 파일시스템 | 작업 temp(`os.tmpdir()`)는 APFS Data 볼륨. `/System/Volumes/VM`은 다른 dev의 APFS 볼륨 |

## 결정 1: Node.js CLI 우선, GUI 프레임워크는 후속

| 기준 | Node.js CLI (채택) | Electron (GUI 후보) | Tauri (GUI 후보) |
| --- | --- | --- | --- |
| 공용 엔진 재사용 | TypeScript 엔진·파일 서비스를 직접 호출 | main 프로세스에서 같은 TS 코드 재사용 가능 | Rust 백엔드가 기본. TS 엔진은 sidecar(Node)나 재작성 필요 |
| 배포 크기 | Node 런타임 전제 또는 단일 실행 파일 묶기(#15에서 결정) | Chromium+Node 포함, 큰 편(이 저장소에서 미측정) | OS WebView 사용으로 작은 편(미측정). sidecar를 쓰면 커짐 |
| OS 휴지통 | macOS `/usr/bin/trash`, Windows PowerShell `SendToRecycleBin`(이 ADR) | `shell.trashItem` 내장 | 플러그인/크레이트 필요, 미검토 |
| 보안 경계 | 단일 프로세스. 경로·승인 검사는 공용 서비스에서 | renderer↔main IPC 검증·격리 설정 필요 | WebView↔Rust command 허용 목록 필요 |

이유: D02/D10(사용자 결정)대로 GUI 없이 핵심 기능을 먼저 완성하고, GUI는 같은 서비스의 어댑터로 붙입니다. 의존성 추가 없이 Node 내장 API와 OS 기본 명령만으로 이동·휴지통·영구 삭제·공간 관측이 가능함을 이 Mac에서 확인했습니다.
Electron 초기 메모리·배포 크기는 **측정하지 않았습니다**(의존성 추가 금지, GUI는 #9 범위). GUI 선택 시 재측정합니다.

## 결정 2: 같은 볼륨 no-clobber 이동 = `link` → 식별 확인 → `unlink`

`linkMoveNoClobber(src, dst, expected?)`:
1. `lstat(src)`: 일반 파일, 링크 아님, `nlink == 1`, `expected`(dev/ino/size/mtimeNs)와 일치. 아니면 `LINK_REJECTED`/`NOT_SUPPORTED`/`FILE_CHANGED`/`SOURCE_MISSING`.
2. `lstat(dirname(dst))`: 실제 폴더(링크 아님). 없으면 `FILE_CHANGED`, 링크면 `LINK_REJECTED`, dev가 다르면 쓰기 전에 `CROSS_VOLUME`.
3. `fs.link(src, dst)`: 커널이 기존 목적지를 덮어쓰지 않고 `EEXIST` → `DEST_EXISTS`. `EXDEV` → `CROSS_VOLUME`, `EPERM/ENOTSUP/EOPNOTSUPP/ENOSYS/EMLINK` → `NOT_SUPPORTED`.
4. `lstat(dst)`의 dev/ino가 1의 값과 같을 때만 `unlink(src)`. 다르면 우리가 만든 이름만 제거하고 `FILE_CHANGED`.
5. `unlink(src)` 실패 시 원본이 그대로 있으면 `dst` 링크를 제거해 이동을 취소. 취소도 못 하면 `UNKNOWN`(중간 상태).
6. 원래 경로 부재와 목적지 dev/ino를 다시 확인.

실측(이 Mac, `tests/platform.test.ts`): 이동 후 원본 부재·목적지 sha256 동일·dev/ino 동일·nlink 1. 기존 목적지가 있으면 `DEST_EXISTS`로 거부되고 두 파일의 경로·크기·mtime·sha256 manifest가 그대로였습니다.

교차 볼륨: `/System/Volumes/VM`(다른 dev)을 목적지 부모로 주면 쓰기 시도 전에 `CROSS_VOLUME`으로 거부되고 원본 manifest가 보존됨을 확인했습니다. 실제 두 번째 쓰기 가능 볼륨에서 `link`가 `EXDEV`를 반환하는 경로는 **미검증**입니다(외장·디스크 이미지 마운트를 하지 않음). 첫 버전은 copy→delete를 하지 않습니다.

중간 상태 위험: `link` 후 `unlink` 전에 프로세스가 죽으면 같은 inode에 두 이름(nlink 2)이 남습니다. 데이터 손실은 없지만 사용자는 같은 파일을 두 곳에서 봅니다.
복구 방침: `classifyMoveState(src, dst, expected)`가 `not-started / linked-both / moved / missing / conflict`만 판정하고 **스스로 고치지 않습니다**. 서비스는 저널 `intent`만 있는 op를 이 값과 함께 `unknown`으로 보고합니다(DESIGN 실행 규칙 7). nlink 2인 원본은 어댑터가 다시 이동·삭제하지 않음(`LINK_REJECTED`)을 테스트로 확인했습니다. 사용자 확인을 받은 정리 동작은 #13에서 정합니다.

## 결정 3: 링크·식별·변경 감지의 범위와 한계

- 식별: `lstat`(bigint)의 `dev, ino, size, mtimeNs, nlink`와 종류. symlink는 `LINK_REJECTED`, 폴더·특수 파일은 `NOT_SUPPORTED`, `nlink > 1`(하드링크)은 이동·삭제 거부.
- Windows junction은 Node/libuv `lstat`에서 symlink로 보고되는 것으로 알려져 있어 같은 거부 경로를 탑니다. OneDrive placeholder 등 다른 reparse point 식별은 **미검증**(CI 대기).
- macOS의 이 Mac에서 symlink·하드링크·폴더 링크 거부를 실제로 확인했습니다. Windows는 symlink 권한이 없으면 해당 테스트를 명시적으로 건너뜁니다.
- 승인 직후 변경 감지: 어댑터는 dev/ino/size/mtimeNs를 `expected`와 비교합니다. sha256 재해시는 서비스가 실행 직전에 수행합니다(기존 스캐너 해시 재사용).
- TOCTOU 한계: Node 경로 API는 `lstat`과 `link/unlink/execFile` 사이에 다른 프로세스가 파일·부모 폴더를 바꾸는 경쟁을 원자적으로 막지 못합니다. `link`의 no-clobber와 사후 dev/ino 확인으로 덮어쓰기와 다른 파일 삭제 위험을 줄였을 뿐, 완전히 없앴다고 주장하지 않습니다. 부모 경로 중간의 링크 교체는 서비스의 realpath·부모 검사(DESIGN 규칙 3)가 함께 막아야 합니다.

## 결정 4: OS 휴지통

- macOS: `execFile('/usr/bin/trash', [abs])`, shell 없음, 절대 경로만(선행 `-`로 옵션 해석되는 일 없음). 성공 후 원래 경로 부재를 확인하고, 실패하면 `TRASH_FAILED`. 영구 삭제로 우회하지 않습니다.
- 실측: `afo-test-trash-*.txt` 합성 파일이 원래 경로에서 사라지고 같은 폴더의 다른 파일·폴더·링크 manifest는 그대로였습니다. 파일은 `~/.Trash/`에 같은 이름·크기로 존재함을 `ls`로 확인했습니다. 없는 파일에 대해 도구는 종료 코드 5와 `NSCocoaErrorDomain Code=4`를 냈습니다(어댑터는 그 전에 `SOURCE_MISSING`으로 거부). TCC 권한 창은 뜨지 않았습니다.
- 복원: 앱 내 복원은 제공하지 않고 사용자가 Finder 휴지통에서 "되돌려 놓기"를 합니다. **Finder 복원의 실물 확인은 하지 않았습니다(미검증)**. GUI 제어를 하지 않기 위해서입니다.
- Windows: `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -Command ...DeleteFile($env:AFO_TRASH_PATH,'OnlyErrorDialogs','SendToRecycleBin')`. 경로는 환경변수로만 전달하고 명령 문자열에 넣지 않습니다. `OnlyErrorDialogs`는 오류 시 대화상자를 띄울 수 있습니다. **구현만, 미검증(CI 대기)**.
- `/usr/bin/trash`가 처음 제공된 macOS 버전은 확인하지 않았습니다. 도구가 없으면 `isTrashSupported()`가 false, `moveToTrash`는 `NOT_SUPPORTED`입니다.
- 휴지통 이동은 공간 확보량으로 세지 않습니다(같은 볼륨에 남음).

## 결정 5: 선택 파일 영구 삭제와 공간 관측

- `deleteFilePermanently(abs, expected?)`: 일반 파일·nlink 1·`expected` 일치일 때만 `unlink`, 이후 부재 확인. 폴더(`NOT_SUPPORTED`), 링크·하드링크(`LINK_REJECTED`), 없는 파일(`SOURCE_MISSING`)은 거부. 남길 파일(keeper)의 존재·sha256 확인은 서비스가 실행 직전에 합니다.
- 실측: 1 MiB 합성 파일 삭제 후 부재, 다른 파일·폴더·링크는 manifest 그대로. `fs.statfs`의 `bavail*bsize`는 삭제 전후 한 번 관측에서 1,048,576 바이트 증가했습니다(두 차례 실행 모두). **다른 프로세스의 쓰기·APFS 스냅샷 등의 영향을 받으므로 정확한 회수량이 아닙니다.** 보고서는 선택 논리 크기와 전후 관측치를 따로 표시합니다.
- `freeSpace(dir)`는 관측 불가(없는 경로, 상대 경로) 시 `null`입니다.

## 결정 6: 저널·잠금·상태 폴더 (DESIGN.md를 따름, 구현은 `state.ts`/서비스 담당)

- 상태 폴더: `AFO_STATE_DIR` → macOS `~/Library/Application Support/AFO`, Windows `%LOCALAPPDATA%\AFO`. 작업 루트와 겹치면 `STATE_DIR_CONFLICT`.
- 지속성: JSON은 temp→fsync→rename→부모 fsync(가능한 OS), 저널 JSONL은 항목마다 append+fsync. 쓰기 전에 `intent`가 기록되지 않으면 파일 작업을 시작하지 않습니다.
- 단일 루트 잠금: `locks/<rootId>.lock`을 `open(..., 'wx')`로 생성(pid·시작 시각). 살아 있지 않은 pid의 잠금만 stale로 해제.
- 이 ADR 범위에서는 위 항목을 구현·측정하지 않았습니다. 이 Mac에서 fsync가 실제 매체 기록까지 보장되는지는 검증하지 않았습니다.

## 미결정: #15에서 결정

- 지원 OS/CPU 최소 범위(macOS·Windows 버전, x64/arm64): **현재 미결정**. 확인한 것은 macOS 27.0.1 arm64 한 대뿐입니다.
- 패키징(Node 설치 전제/단일 실행 파일)과 코드 서명·notarization·SmartScreen: **현재 미결정**.

## 측정치 (실측 1회, 이 Mac 한정)

| 항목 | 값 |
| --- | --- |
| 입력 | 10개 폴더 × 작은 텍스트 파일 100개 = 1,000개 합성 파일(temp) |
| `scanFolder` 소요 | 44.4 ms (같은 날 재실행 43.0 ms) |
| `process.memoryUsage().rss` | 85.7 MiB (node --test 프로세스 전체, 스캔 단독 아님) |
| 환경 | Node v24.18.0, darwin/arm64, macOS 27.0.1 |

`node --test`의 진단 출력(`tests/platform.test.ts` 마지막 테스트)으로 재현합니다. 성능 기준값이나 Windows 수치로 쓰지 않습니다. 해시를 포함한 `analyzeFolder`와 큰 파일 스트리밍은 측정하지 않았습니다.

## 검증하지 못한 것

- Windows 전 항목(link no-clobber, junction 식별, PowerShell 휴지통, statfs): CI 대기.
- 실제 두 번째 쓰기 가능 볼륨에서의 `EXDEV`, exFAT/FAT 등 하드링크 미지원 파일시스템의 오류 코드.
- Finder 휴지통 복원, 휴지통 이동 후 공간 변화, 재시작 후 결과 확인(#13).
- Electron/Tauri 메모리·배포 크기.

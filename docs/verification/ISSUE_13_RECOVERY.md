# #13 중단된 실행 보고(`inspectRuns`) 구현 기록

역할: core-builder. 날짜: 2026-10-26. 기준 commit `6231c6a`(origin/main), 브랜치 `feat/13-recovery`.
범위: #13 중 **보고 전용** 중단 실행 점검(DESIGN 실행 규칙 7). 잠금(`lock.ts`)·장애 주입 실행·CLI `recover`/`runs` 출력은 다른 작업자 범위이며 여기 포함하지 않습니다.
이 문서는 구현자 기록입니다. 독립 verifier 검증은 아직 하지 않았습니다.

## 무엇을 하는가

`packages/filesystem/src/recovery.ts`의 `inspectRuns(stateDir, { loadPlan? })`는 `statePaths(stateDir).journal/*.jsonl`을 모두 읽고,
완료 기록이 없는 작업을 실제 파일 상태와 대조해 **보고만** 합니다.

절대 하지 않는 일(코드에 쓰기 API 호출이 없고, 모든 테스트가 루트·상태 폴더 manifest 전후 동일을 확인):
- 파일 rename·link·unlink·쓰기, 폴더 생성, 저널·계획 수정
- 작업 재실행, 이동 원복, linked-both의 한쪽 이름 정리, 휴지통 복원, 삭제
- 손상된 저널 줄의 내용 추측, 링크·junction이나 루트 밖 경로 따라가기

## 판정 규칙

- 작업별로 유효 저널 항목을 순서대로 봅니다. `intent` 뒤 `done|failed|skipped`, `undo-intent` 뒤 `undone|failed|skipped`이면 완료(보고·재실행하지 않음). 첫 기록이 단독 `failed|skipped`인 작업은 시작 전에 거부된 것으로 보고 완료로 셉니다.
- 같은 작업의 기록끼리 kind·source·destination·before(dev/ino/size, 둘 다 있을 때 sha256)가 다르거나, 시작 없는 `done/undone`, 이중 `intent`, 완료되지 않은 이동의 `undo-intent` → `unknown`(`JOURNAL_INCONSISTENT`).
- 손상 줄이 하나라도 있으면 실행 상태는 `corrupt`, 열린 작업은 모두 `unknown`(`JOURNAL_DAMAGED`)이며 손상 줄 번호·이유를 함께 보고합니다. 손상 줄이 그 작업의 완료 기록이었을 수 있기 때문입니다. 실제로 관측한 상태는 `observed`에 참고로만 남깁니다.
- 실행 ID가 파일 이름과 다르거나 한 저널에 다른 planId·rootGrantId가 섞이면 실행 전체를 `corrupt`, 열린 작업을 `unknown`으로 보고하고 계획을 찾지 않습니다.

### 계획 파일 가정

루트 경로는 저널에 없으므로 **`statePaths(stateDir).plans/<planId>.json`에 `OperationPlanSchema` 형식으로 저장된 계획**에서 찾습니다(세션 A의 `approvals.ts`가 이 위치에 쓴다는 가정, #8에서 확인 필요). 다른 저장 위치는 `options.loadPlan`으로 주입할 수 있으며, 반환값은 다시 스키마로 검증합니다.
- 계획 없음 → `unknown`, action "계획 파일이 없어 실제 상태를 확인할 수 없음…" (`PLAN_MISSING`)
- 계획 손상·스키마 불일치(루트 밖 `../` 경로 포함) → `unknown`(`STATE_CORRUPT`)
- `plan.id`·`plan.rootGrantId`가 저널과 다름, 계획에 해당 작업이 없거나 kind·경로가 다름 → `unknown`(`PLAN_MISMATCH`)
- 작업 폴더가 없음(`SOURCE_MISSING`), 링크(`LINK_REJECTED`), 실제 경로가 계획의 `rootPath`와 정확히 같지 않음(`ROOT_FORBIDDEN`) → `unknown`
- 상대 경로는 `RelativePathSchema`로 다시 검증한 뒤 `path.join`. 루트 밖이면 `PATH_OUTSIDE_ROOT`, 루트 아래 이미 있는 부모 구성요소 중 링크가 있으면 `LINK_REJECTED`, 폴더가 아니면 `FILE_CHANGED`(각 구성요소 `lstat`, 따라가지 않음).
- 점검 중 오류 → `unknown`, `detail`에 오류 코드.

### 상태와 안내(action)

| 작업 | 상태 | 판정 기준 | 안내 요지 |
| --- | --- | --- | --- |
| move `intent` | not-started | 원래 경로=같은 dev/ino, 목적지 없음 | 시작 안 됨, 원래 경로에 그대로. 필요하면 새 계획·승인 |
| | linked-both | 두 경로 모두 같은 inode, nlink 2 | 하드링크 2개, 데이터 손실 없음. 사용자가 확인 뒤 한쪽 이름 정리. 자동 삭제 없음 |
| | moved | 원래 경로 없음, 목적지=같은 inode | 이동 완료, 완료 기록만 없음. 다시 실행하지 않음 |
| | missing | 두 경로 모두 없음 | 위치를 추측하지 않음, 사용자 확인 |
| | conflict | 그 밖(다른 파일·링크·nlink 불일치) | 어느 쪽도 바꾸지 않음, 사용자 확인 |
| move `undo-intent` | 위와 같음(목적지→원래 경로 방향) | `classifyMoveState(목적지, 원래 경로)` | 되돌리기 기준 문구 |
| trash `intent` | not-started / missing / conflict | 원래 경로가 같은 dev/ino·일반 파일·nlink 1 / 없음 / 그 밖 | missing: 휴지통 이동 여부를 알 수 없으니 OS 휴지통에서 확인 |
| delete `intent` | not-started / missing / conflict | 위와 같음 | missing: 끝났는지 알 수 없음, 되돌릴 수 없음, 다시 실행하지 않음 |

모든 안내는 자동 수정을 약속하지 않습니다. 실행 상태: `clean`(열린 작업 없음), `unfinished`, `corrupt`, `unreadable`.

### 저널 폴더의 특이한 이름

`.jsonl`이 아닌 이름(temp 파일 등)은 무시합니다. 실행 ID 형식이 아닌 이름, 링크, 폴더, UTF-8이 아닌 파일은 따라가거나 해석하지 않고 `unreadable`(`problem`에 이유)로 보고합니다. 저널 폴더 자체가 링크이거나 폴더가 아니면 `STATE_CORRUPT`, 폴더가 없으면 빈 배열입니다. 실행은 ID 바이트 순, 작업은 저널 순서로 결정적으로 정렬합니다.

## 실행한 명령과 결과 (이 Mac)

환경: macOS 27.0.1 arm64, 실물 Mac 1대, Node v24.18.0. 모든 파일은 `mkdtemp(os.tmpdir())/afo-test-*` 합성 폴더(루트, 상태 폴더 각각 별도).

```text
npm ci --ignore-scripts --no-audit --no-fund   # 4 packages
npm run typecheck                              # exit 0
npm test                                       # tests 99, pass 97, fail 0, skipped 2 (기존 실제 휴지통 검사 2건: AFO_REAL_TRASH_TEST 미설정)
node --test dist/tests/recovery.test.js        # tests 10, pass 10, fail 0, skipped 0
```

`tests/recovery.test.ts` 10개는 중단 상태를 실제 파일 조작으로 만듭니다(link만 → linked-both, link+unlink → moved, rm → missing, 같은 이름 새 파일·목적지 선점·하드링크 추가 → conflict).
사례: 이동 5상태(conflict 2종), 되돌리기 3상태, 휴지통·영구 삭제 각 3상태, 완료 작업(done/failed/skipped/단독 skipped/undone) 미보고, 중간 손상 줄·루트 밖 경로를 담은 줄·잘린 마지막 줄, 계획 없음·rootGrantId/id/작업 불일치·`../` 경로·없는/비정규/상대 루트, 루트 안 부모 링크(원래 경로 쪽·목적지 쪽·밖을 가리키는 조부모), 기록 불일치 3종과 실행 ID/계획 혼합, 저널 폴더의 특이한 이름, 빈·없는 상태 폴더와 링크 저널 폴더.
파일을 읽는 모든 `inspectRuns` 호출(경로 형식만 보고 거부하는 상대 경로 1건 제외) 전후 루트·상태 폴더(링크 사례는 밖 폴더 포함)의 manifest(경로·종류·크기·mtimeNs·sha256·링크 대상)가 같음을 확인했습니다.
oracle 점검: 빌드 산출물에 `unlink`를 일부러 넣었을 때 manifest 비교가 3개 테스트를 실패시키는 것을 확인한 뒤 다시 빌드했습니다.

## 검증 수준

- macOS: **Unit-verified**, 이 Mac 실제 APFS temp 폴더에서 실행(실물 1대, 합성 파일만).
- Windows: **미검증(CI 대기)**. symlink 권한이 없으면 링크 사례는 명시적으로 건너뜁니다. junction은 `lstat`에서 링크로 보고된다는 ADR 0001 가정에 의존합니다.
- 실제 executor(#10–#12)가 남긴 저널과의 통합, 실제 프로세스 강제 종료 주입은 **미검증**: 이 테스트는 저널을 직접 쓰고 파일 상태를 손으로 만듭니다.

## 남은 위험

- 계획 저장 위치·undo 저널 형식(되돌리기도 앞 이동과 같은 source/destination/before를 기록한다고 가정)은 세션 A·B 구현과 맞춰 확인해야 합니다.
- 손상 줄 안에만 있던 작업(시작 기록 자체가 손상)은 opId를 알 수 없어 작업 단위로 보고하지 못합니다. 실행 상태 `corrupt`와 줄 번호로만 드러납니다.
- 작업 폴더 경로가 같은 이름의 다른 폴더로 바뀐 경우는 루트 자체의 dev/ino를 계획에 저장하지 않아 직접 구분하지 못합니다. 파일 dev/ino 비교 때문에 다른 폴더의 파일은 `conflict`/`missing`으로 보고됩니다.
- 점검과 사용자의 확인 사이에 파일이 다시 바뀔 수 있습니다. 보고는 점검 시점의 관측입니다.

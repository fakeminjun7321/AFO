# #14 macOS CLI 사용자 경로 독립 검증 (#10·#11·#12 CLI 경로 포함)

상태: **verifier 독립 검증 기록**. 2026-10-28. 이 문서는 #14의 macOS 부분만 다룹니다. Windows 실물은 범위 밖입니다(NOT-RUN).
제품 코드(`packages/`, `apps/`)는 고치지 않았습니다. 추가한 파일은 `tests/verify-14-macos.test.ts`와 이 문서뿐입니다.

## 보고 양식

```text
Issue / PR / Commit: #14(macOS 부분), #10·#11·#12 CLI 경로 / draft PR #48 / 기준 origin/feat/cli-apply 00786a4c6e74c063e7d68ae18a63be257e500ae6
Environment: macOS 27.0.1 (26A434), Apple M5 (arm64), Node v24.18.0, APFS(Data 볼륨) — physical(이 Mac), 합성 temp 폴더만
Fixture and baseline manifest: 테스트마다 mkdtemp(os.tmpdir(), 'afo-test-v14-') 아래 home/(가짜 HOME), state/(AFO_STATE_DIR), work*/, ref/
  manifest는 테스트 파일 안에서 직접 계산: 링크를 따라가지 않는 lstat(bigint)으로 상대 경로·종류·크기·mtimeNs·dev·ino, 파일은 sha256
  기대 목적지는 손으로 적은 표(제품 함수를 oracle로 쓰지 않음)
Steps or exact commands: 아래 "실행한 명령", 사용자 경로는 모두 실제 자식 프로세스 `node dist/apps/cli/src/index.js …`
Observed files / hashes / journal / exit status: 시나리오 표와 "관측" 절
Passed / Failed / Not run: 시나리오 행 15개 PASS / FAIL 0 / NOT-RUN은 아래 표. tests/verify-14-macos.test.ts 12개 테스트(실제 휴지통 1개는 AFO_REAL_TRASH_TEST=1에서만)
Verification level: Physical-device-verified(macOS, 이 Mac, 합성 폴더) / Windows NOT-RUN
Not verified and reason: "미검증" 절
Release blocker and unblock condition: 데이터 손실·승인 밖 삭제·덮어쓰기·루트 이탈은 발견하지 못함. 출시 차단 결함 없음(이 범위에서)
```

## 실행한 명령

```sh
git fetch origin && git checkout -b verify-14-macos origin/feat/cli-apply   # HEAD 00786a4
rm -rf dist && npm run typecheck && npm test                               # 2회 실행(아래 결과)
AFO_REAL_TRASH_TEST=1 node --test --test-name-pattern="S4 trash" dist/tests/verify-14-macos.test.js   # 실제 휴지통 1회
```

- `npm run typecheck`: 오류 없음.
- `npm test` 1회차: tests 424 / pass 414 / **fail 1** / skipped 9. 실패는 기존 `tests/verify-8.test.ts`의 V8-M2(아래 O-6, 테스트 자체의 확률적 결함). 이 문서의 테스트는 모두 통과.
- `npm test` 2회차(같은 커밋, 다시 `rm -rf dist`): tests 424 / **pass 415 / fail 0** / skipped 9. skipped 9는 `AFO_REAL_TRASH_TEST=1`·디스크 이미지 등 환경 조건 테스트(이 파일의 S4 trash 포함).
- `AFO_REAL_TRASH_TEST=1` 단독 실행: S4 trash 1개 pass. 실제 OS 휴지통으로 보낸 것은 합성 파일 `afo-test-v14-<무작위>.txt` 1개뿐이며 휴지통을 읽거나 비우지 않았습니다.
- 테스트가 끝난 뒤 `$TMPDIR/afo-test-*` 잔여 폴더 0개를 확인했습니다.

## 시나리오별 결과

| # | 시나리오 (테스트 이름 접두) | 결과 | 근거 |
| --- | --- | --- | --- |
| 1 | S1 참고 폴더 → `suggest-rules` → `rules save --select`(과제 규칙 2개만, 사진 규칙 미확인) → 새 프로세스 `preview` → `plan` → `apply --mode organize --confirm` → `runs` → `recover` → `undo` | PASS | preview·plan 목적지 = 손으로 쓴 표(`물리_보고서.pdf → 과제/물리/…`, `수학_숙제.pdf → 과제/수학/…`, `IMG_1.jpg → 이미지/…`(사진 규칙은 미확인이라 기본), 한글·공백·이모지 `.pptx → 문서/…`, `README` 검토). apply 뒤 목적지 sha256·inode·mtime = 원본, 원래 경로 부재, 나머지 불변. 참고 폴더 manifest(경로·바이트·mtime·inode) 전 단계 불변. 저널 `journal/<runId>.jsonl`에 작업마다 `intent`→`done`, `done.after.sha256` = 원래 해시, `after.inode` = 관측 inode. `runs --json` 1개(organize, undoable), `recover --json` = `{checked:1, runs:[]}`. `undo`는 코드 없음/틀림 → 4·무변경, 맞는 코드 → 파일 manifest(경로·sha256·mtime·dev/ino)가 처음과 **동일** |
| 1b | S1b 참고 폴더가 작업 루트 안(`--reference work/참고`) | PASS | 참고 파일은 계획에 없음, `--delete-file 참고/…` → 1 `ROOT_FORBIDDEN`, apply 뒤 참고 파일 manifest 불변 |
| 2 | S2 재시작 후 새 합성 파일(다른 작업 폴더 `work2`, 대문자 확장자 포함)에 같은 규칙 | PASS | 모든 명령이 별도 프로세스. `물리_실험보고서2.pdf → 과제/물리/`, `수학_기말.pdf → 과제/수학/`, `photo.JPG → 이미지/`, `여행 메모.TXT → 문서/`로 실제 이동. 프로필 revision은 plan·apply로 바뀌지 않음 |
| 3 | S3 `--move … --remember` / 일회성 `--move` / `rules reset` | PASS | 저장한 수정(`IMG_2.jpg=사진/여행`)이 다음 plan에 반영. 일회성 `plan --move README=기타`는 그 계획에만, `preview --move`(remember 없음) 뒤의 plan에는 없음. 비TTY `rules reset`은 2, `--confirm reset` 뒤 기본 분류(`문서/`, `이미지/`). 이 과정에서 작업 폴더 불변 |
| 3' | 프로필 변경(reset) 뒤 이전 계획 apply | PASS(종료 코드는 O-1) | `PROFILE_CHANGED`, **종료 코드 1**, 승인 기록 0개, 파일 불변 |
| 4a | S4 `--delete-duplicates all --delete-mode permanent` → `apply --mode permanent-delete --confirm --phrase "영구 삭제"` | PASS | 손으로 쓴 그룹 {a.txt, a copy.txt}, {b1,b2,b3}: 그룹마다 keeper 1개만 남고 후보 3개 부재, keeper·크기만 같은 `a2.txt`·`other.pdf`의 manifest 불변. 문구 없음·틀림 → 4, `--mode trash` → 4(MODE_MISMATCH), organize에 `--phrase` → 2, 거부 동안 승인 기록 0개. 출력에 `영구 삭제함`, `되돌릴 수 없`, `여유 공간(관측): 실행 전 … B → 실행 후 … B`, `확보량 아님`, undo 안내 없음. 저널 intent→done. `undo` → 1("되돌릴 수 없"), `runs` 상세에 "undo 가능" 없음 |
| 4b | S4 trash(실제 OS 휴지통, `AFO_REAL_TRASH_TEST=1`에서 1회) | PASS | `afo-test-v14-…` 중복 1개만 `휴지통으로 보냄`, keeper sha256 유지, 다른 파일 불변. 출력에 `확보량 아님`, `여유 공간(관측)` 없음, `휴지통에서 직접 복원` 안내, undo 안내 없음. `undo` → 1 |
| 5 | S5 승인 경계 | PASS | 아래 표 |
| 5' | S5 영구 삭제 재해시: 후보·keeper를 **같은 크기로 바꾸고 mtime 복원** | PASS | 후보 `FILE_CHANGED`, keeper 변경 `KEEPER_INVALID`, 종료 3, 아무것도 삭제되지 않음(manifest 동일) |
| 5'' | S5 권한 거부: plan 뒤 원본 폴더를 0555로 | PASS | 그 항목 `failed:PERMISSION_DENIED`(unknown 아님), 원본 그대로·사본 없음, 다른 항목 이동, 종료 3, `recover` 빈 결과 |
| 6a | S6 같은 계획·같은 코드로 동시 apply 2개(40파일) | PASS | 정확히 하나만 0, 다른 하나는 `LOCKED_BY_OTHER`(1). 파일은 정확히 한 번 이동, 실행 기록 1개, recover 빈 결과. 추가 탐침 50회(1파일, 0~120ms 지연): `0 | 1 LOCKED_BY_OTHER` 29회, `0 | 4 APPROVAL_USED` 21회, 두 번째 실행 기록 0회 |
| 6b | S6 비TTY `--yes` | PASS | `--yes` 단독·유효 코드와 함께 모두 2 |
| 6c | S6 상태 폴더를 작업 루트 안에(`AFO_STATE_DIR=work/.afo-state`) | PASS | `plan`·`preview --move --remember` → 1 `STATE_DIR_CONFLICT`, 작업 폴더에 상태 폴더·파일이 생기지 않음 |
| 6d | `recover`가 정상 실행 뒤 비어 있음 | PASS | S1(apply 뒤, undo 뒤), S5'', S6a에서 `{checked:N, runs:[]}`, 종료 0 |
| 7 | 출력 정직성 | PASS | 휴지통: plan·apply 확인 요약에 "확보량 아님. 휴지통으로 보낸 파일은 디스크에 남습니다", 결과에 여유 공간 관측 줄 없음. 영구 삭제: "되돌릴 수 없음". 이동이 아닌 실행(휴지통·영구 삭제)에 `undo <실행 ID>` 제안 없음, 이동 실행에는 있음 |

S5 승인 경계 상세(`--delete-mode permanent` 계획 사용, 실제 휴지통을 건드리지 않도록):

| 사례 | 종료 코드 | 파일·상태 |
| --- | --- | --- |
| 비TTY `--confirm` 없음 | 4 | 불변, `approvals/`·`runs/` 0개 |
| 틀린 코드 `00000000` | 4 | 불변 |
| organize에 permanent-delete 코드 / permanent-delete에 organize 코드(+문구) | 4 / 4 | 불변 |
| `--yes` / 유효 코드 + `--yes` | 2 / 2 | 불변 |
| 없는 계획 ID | 4 | 불변 |
| `--only <a>`에 전체 코드 | 4 | 불변. apply가 보여 준 부분 코드로만 `a.pdf → 문서/a.pdf` 이동 |
| 재사용: 같은 `--only`·같은 코드 / 그 작업을 포함한 전체 | 4 `APPROVAL_USED` / 4 | 불변 |
| 계획 파일 변조: 목적지 `../escaped/b.jpg` | **1 `STATE_CORRUPT`**(O-2) | 불변, 루트 옆에 아무것도 생기지 않음, 승인 기록 추가 없음 |
| 계획 파일 변조: 목적지 `다른곳/b.jpg`(계약상 유효) | 4 `PLAN_CHANGED` | 불변, 승인 기록 추가 없음 |
| plan 뒤 원본 수정(같은 길이) + 목적지 선점 | 3 | `b.jpg` `FILE_CHANGED`(새 내용 그대로 원래 위치), `c.mp4` `DEST_EXISTS`(선점 파일 해시 그대로, 덮어쓰지 않음), 나머지 이동 |

## 관측과 결함

데이터 손실·승인 밖 삭제·덮어쓰기·루트 이탈: **발견하지 못했습니다.**

- **O-1 (문서 불일치, 안전 영향 없음)**: `docs/CLI.md`의 apply 절은 "바뀐 개인 규칙은 서비스가 거부합니다(4, …)"라고 적지만, 실제 종료 코드는 **1**(`PROFILE_CHANGED`)입니다. 같은 문서의 종료 코드 표는 `PROFILE_CHANGED`를 1에 둡니다. 재현: S3(`rules reset --confirm reset` 뒤 이전 계획 `apply … --confirm <코드>`). 파일·승인 기록 변경은 없습니다. 문서와 코드 중 어느 쪽을 맞출지는 담당자 결정입니다.
- **O-2 (문서 범위, 안전 영향 없음)**: 계약에 맞지 않게 변조한 계획 파일(목적지 `../…`)은 `PLAN_CHANGED`(4)가 아니라 `STATE_CORRUPT`(1)로 거부됩니다. CLI.md 종료 코드 4의 "바뀐 계획(PLAN_CHANGED)"에는 이 경우가 없습니다. 재현: S5 변조 사례.
- **O-3 (문서화된 동작)**: undo 뒤 이동이 만든 빈 폴더(`과제`, `과제/물리`, `과제/수학`, `문서`, `이미지`)가 남습니다. 파일은 모두 원래 경로·해시·mtime·inode로 돌아왔습니다.
- **O-4 (남은 위험, 미관측)**: CLI의 같은 작업 재실행 거부(`refuseRepeated`)는 루트 잠금 밖에서 실행 기록을 읽습니다. 두 번째 프로세스가 첫 실행의 기록 저장 전에 이 검사를 통과하고 첫 실행이 잠금을 푼 뒤 잠금을 얻으면 같은 작업에 두 번째 승인이 발급될 수 있습니다. 50회 탐침에서 0회였고, 그 경우에도 실행 직전 재검증이 원본 부재로 실패시킬 것으로 보이지만 **검증하지 않았습니다**.
- **O-5 (정직성 확인)**: 영구 삭제의 관측 여유 공간 차이는 실행마다 +4 KiB, +8 KiB, −32 KiB처럼 작거나 음수였습니다. CLI는 이를 "관측, 다른 프로그램의 쓰기 영향 가능, 정확한 회수량 아님"으로 표시해 확보량으로 단정하지 않습니다.
- **O-6 (기존 테스트의 확률적 결함, 제품 결함 아님)**: `tests/verify-8.test.ts` V8-M2는 대문자로 바꾼 승인 코드를 틀린 코드로 기대하지만, 8자 16진 코드가 숫자로만 이뤄지면(확률 약 (10/16)^8 ≈ 2.3%) `toUpperCase()`가 원래 코드와 같아 승인이 발급되고 테스트가 실패합니다. 1회차에서 코드 `44568281`로 실제 발생했고 2회차는 통과했습니다. 다른 검증 기록의 파일이라 고치지 않았습니다. 대문자 사례를 문자가 있는 코드에서만 검사하도록 바꿀 것을 제안합니다.
- 참고(설계상 한계, 테스트하지 않음): 해시하지 않은 이동 원본을 같은 크기로 바꾸고 mtime을 되돌리면 실행 직전 재검증이 변경을 알아채지 못합니다. 이동은 바이트를 보존하므로 데이터 손실은 아닙니다. 삭제 작업은 S5'에서 재해시로 막히는 것을 확인했습니다.

## 미검증 (NOT-RUN)

| 항목 | 이유 |
| --- | --- |
| Windows 실물 전체 | 이 Mac에서 검증할 수 없음. CI/VM 결과로 대신하지 않음 |
| OS 휴지통에서 사용자가 복원 | 안전 규칙상 휴지통을 읽거나 조작하지 않음. Finder 수동 복원은 사람이 확인해야 함 |
| TTY 대화형 입력(코드·문구·reset 질문) | 자식 프로세스에 pty가 없음. 이 문서는 비TTY 경로만 검증 |
| Ctrl+C(130) 취소, 잠금 해제 실패·결과 저장 실패 안내 | 자동 재현 수단 없음 |
| 계획 만료(1시간)·승인 만료(10분) | 시간 조작 없이 재현하지 않음 |
| CLI의 프로필 손상·규칙 충돌·근거 부족·참고 폴더 이름 변경(`PROFILE_STALE`) | 기존 `tests/cli-rules.test.ts`·verify-18이 다룸. 이 검증에서 독립 재현하지 않음 |
| apply 시점에 상태 폴더가 루트 안인 경우 | plan·preview `--remember`의 거부만 확인(그 상태로는 apply할 계획이 만들어지지 않음) |
| 교차 볼륨 이동 거부 | 기존 V10-05b(디스크 이미지 조건)가 다룸, 이번에는 실행하지 않음 |
| O-4 경쟁의 실제 발생 | 50회 탐침에서 미발생 |

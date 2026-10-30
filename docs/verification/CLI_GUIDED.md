# CLI 안내형 정리(`afo`)·`afo undo`(ID 생략) 독립 검증 — 실제 pty

상태: **verifier 독립 검증 기록**. 2026-10-30. 대상은 `origin/feat/cli-guided`의 안내형 CLI(`apps/cli/src/guided.ts`, `index.ts`)와 `docs/CLI.md` "빠른 시작"입니다.
제품 코드(`packages/`, `apps/`)는 고치지 않았습니다. 추가한 파일은 `tests/verify-cli-guided.test.ts`와 이 문서뿐입니다.
대화형 경로는 모두 **실제 의사 터미널(pty)** 에서 구동했습니다. 프로세스 내 주입(`runCli`의 `ask` 대체)은 사용하지 않았습니다.

## 보고 양식

```text
Issue / PR / Commit: CLI 안내형 정리(afo)·afo undo ID 생략·bin 등록 / PR 없음(검증만) / 기준 origin/feat/cli-guided 6fccce4f597d20b297a3937e6e90c34ea2ab6c89
Environment: macOS 27.0.1 (26A434), Apple M5 (arm64), Node v24.18.0, Python 3.13.9(pty 표준 모듈) — physical(이 Mac), 합성 temp 폴더만
Fixture and baseline manifest: 테스트마다 mkdtemp(os.tmpdir(), 'afo-verify-guided-') 아래 home/(가짜 HOME), state/(AFO_STATE_DIR),
  home/내 과제 📁 2026/(작업 폴더, 한글·공백·이모지). 실제 홈 안이면 setup이 거부. 테스트 종료 시 base 삭제
  manifest는 테스트 파일 안에서 직접 계산: 링크를 따라가지 않는 lstat(bigint) — 상대 경로·종류·크기·mtimeNs, 파일은 sha256, 링크는 대상 문자열
  기대 목적지는 손으로 적은 표(제품 함수를 oracle로 쓰지 않음). 상태 폴더는 approvals/·runs/·journal/ 존재·항목으로 따로 대조
Steps or exact commands: 아래 "실행 방법"과 "실행한 명령"
Observed files / hashes / journal / exit status: 시나리오 표
Passed / Failed / Not run: 시나리오 15행 PASS 14 / FAIL 1(D1, 표시 정직성 — 데이터 영향 없음) / NOT-RUN 1(Windows)
Verification level: Physical-device-verified(macOS, 이 Mac, 실제 pty, 합성 폴더) / Windows NOT-RUN / Linux pty는 CI에서만 실행될 수 있음(이 기록에서는 미실행)
Not verified and reason: "미검증" 절
Release blocker and unblock condition: 데이터 손실·승인 밖 이동/삭제·덮어쓰기·루트 이탈은 발견하지 못함. 출시 차단 결함 없음(이 범위에서). D1은 수정 권장
```

## 실행 방법(pty)

`tests/verify-cli-guided.test.ts`는 표준 라이브러리만 쓰는 작은 Python 드라이버를 temp base에 써 두고 `python3 -I <드라이버> <spec.json>`으로 실행합니다.
드라이버는 `pty.fork()`로 `node dist/apps/cli/src/index.js`(또는 심볼릭 링크 `afo`)를 자식으로 띄워 stdin·stderr를 pty에 연결하고,
화면(ANSI 제거)에서 기대 문구를 찾은 뒤 사람처럼 입력합니다: Enter는 `\r`, Ctrl+C는 바이트 `0x03`(터미널 line discipline/readline이 해석).
화면의 승인 코드·되돌리기 코드는 정규식 그룹으로 읽어 그대로 입력합니다. stdout만 파일로 분리해 "결과는 stdout, 질문은 stderr"도 대조했습니다.
Windows와 python3(pty)가 없는 환경에서는 사유와 함께 skip합니다.

## 실행한 명령

```sh
git fetch origin && git checkout -b verify-cli-guided origin/feat/cli-guided    # HEAD 6fccce4
npm ci --ignore-scripts --no-audit --no-fund
rm -rf dist && npm run typecheck && npm test
AFO_REAL_TRASH_TEST=1 node --test --test-name-pattern="real OS trash" dist/tests/verify-cli-guided.test.js   # 실제 휴지통 1회
python3 -I <scratch>/cancel_scan.py   # 분석 중 Ctrl+C(수동 pty, 합성 64 KiB 파일 4,000개) — 테스트 파일에는 넣지 않음(시간·용량)
```

- `npm run typecheck`: 오류 없음.
- `npm test`(`rm -rf dist` 뒤): **tests 444 / pass 432 / fail 0 / skipped 11 / todo 1**. 이 파일은 11개(통과 9, skip 1 = 실제 휴지통, todo 1 = D1).
  skipped 11은 `AFO_REAL_TRASH_TEST=1`·디스크 이미지 등 환경 조건 테스트입니다.
- `AFO_REAL_TRASH_TEST=1` 단독 실행: 이 파일의 휴지통 테스트 1개 pass. 실제 휴지통으로 보낸 것은 합성 사본 `afo-test-guided-pty-<pid>-<시각> copy.txt` 계열 1개뿐이며 휴지통을 읽거나 비우지 않았습니다.
- 끝난 뒤 `$TMPDIR/afo-verify-guided-*` 잔여 폴더 0개.

## 시나리오별 결과

| # | 시나리오 | 결과 | 근거 |
| --- | --- | --- | --- |
| 1 | 드래그 형식 5종: `'경로'`, `"경로"␠␠`, `\␠` 이스케이프 + 뒤 공백, `~/내\ 과제\ 📁\ 2026`(가짜 HOME), 앞 공백 + 이스케이프 없는 원문 — 폴더 이름은 한글·공백·이모지 | PASS | 5회 모두 재질문 없이 "파일 6개를 살펴봤어요" → 메뉴 1 → 빈 코드(4). 매 회 새로 저장된 `plans/<id>.json`의 `plan.rootPath`(NFC) = 작업 폴더 realpath. 파일 manifest 불변, approvals/·runs/·journal/ 없음 |
| 2 | 없는 폴더 → 홈 자체(`~`, 가짜 HOME) → 파일 경로 | PASS | 각각 "이 폴더는 정리할 수 없어요: 선택한 폴더를 찾거나 읽을 수 없습니다 / 홈 전체, … / 일반 폴더를 직접 선택해야 합니다(…)" 뒤 재질문. 3번째 실패 후 "폴더를 3번 열지 못해 그만둘게요" 종료 1. 질문 정확히 3회, 파일 불변, 상태 폴더 비어 있음 |
| 3 | 메뉴 1·2 → 틀린 코드(`00000000`, `ffffffff`, `abcdefgh-x`) / 빈 입력 | PASS | 5회 모두 종료 4, "코드가 맞지 않아 / 코드를 입력하지 않아 실행하지 않았어요. 아무것도 바꾸지 않았어요." stdout 비어 있음. 파일 manifest·approvals/·runs/·journal/ 불변(plans/에는 계획만 저장 — plan과 같은 동작) |
| 4 | 메뉴 1 → 화면의 코드 입력 → 실제 이동 | PASS | 종료 0. 목적지 5개(`문서/a.pdf`, `이미지/b.jpg`, `영상/clip.mp4`, `문서/c.txt`, `문서/c copy.txt`) sha256·mtimeNs = 원본, 원래 경로 부재, `notes`(검토) 불변, 파일 수 동일. stdout = "정리를 마쳤어요. (실행 ID …) / 옮김 5 · 건너뜀 0 · 실패 0 / 되돌리려면: afo undo"만, 질문은 stdout에 없음 |
| 5 | 새 프로세스 `afo undo`(ID 생략): Ctrl+C → 틀린 코드 → 맞는 코드 → 다시 `afo undo` | PASS | "가장 최근에 정리한 기록을 되돌려요" 표시. Ctrl+C 130·틀린 코드 4는 이동 후 manifest 불변. 맞는 코드 → 종료 0, 파일 manifest(경로·sha256·mtimeNs)가 처음과 **동일**, `문서/`·`이미지/`·`영상/`은 빈 폴더로 남음(문서대로). 다시 `afo undo` → "되돌릴 수 있는 정리 기록이 없어요" 0 |
| 6 | 메뉴 4 / 메뉴에서 빈 Enter / 첫 질문에서 빈 Enter | PASS | 모두 0, stdout "그만뒀어요. 아무것도 바꾸지 않았어요.", 파일·상태 불변 |
| 7 | Ctrl+C: 폴더 질문, 경로 입력 도중, 메뉴, 3) 뒤 메뉴, 코드 질문(정리·휴지통), undo 코드 질문 | PASS | 모두 130, "AFO: 취소했습니다(Ctrl+C). 실행 전이었다면 아무것도 바꾸지 않았습니다." 파일 manifest·approvals/·runs/·journal/ 불변 |
| 8 | Ctrl+C: 분석 중("폴더를 살펴보는 중이에요…", 64 KiB 파일 4,000개, 수동 pty 1회) | PASS | 130, 파일 manifest(mtime·sha256) 불변, 상태 폴더 비어 있음. 문구는 "AFO 오류[CANCELLED]: 분석을 취소했습니다."(O9) |
| 9 | 중복 없는 폴더에서 메뉴 2 / 할 일 없는 폴더(검토 1 + 이미 정리 1)에서 메뉴 1·2 | PASS | "— 할 일 없음" 표시, 고르면 "그 작업은 할 일이 없어요. 다른 번호를 골라 주세요." 후 재질문, 코드 화면 없음. 알아듣지 못한 답 3번(1, 9, 1) → 종료 2. 파일·상태 불변 |
| 10 | 메뉴 2 휴지통(`AFO_REAL_TRASH_TEST=1`, 1회) | PASS | 종료 0, stdout "휴지통으로 보냄 1 · 건너뜀 0 · 실패 0"과 "afo undo로는 되돌리지 않아요". 사본 둘 중 정확히 1개 남고 남은 파일 manifest 불변, 다른 파일 불변. 화면에 "확보"·"공간" 없음. 휴지통 내부는 읽지 않음(가짜 HOME 환경에서 `/usr/bin/trash` 성공·원래 경로 부재로만 판정) |
| 11 | 저장 규칙 없음 / 적용 / 꺼짐 표시 + 참고 파일 보호(참고 폴더 `정리함/`이 작업 폴더 안) | PASS | 없음: "저장된 내 정리 규칙이 없어 기본 분류(…)를 썼어요." `suggest-rules 정리함` → 물리 규칙만 `rules save` 뒤: "저장된 내 정리 규칙을 적용했어요.", `물리_새보고서.pdf → 과제/물리/…`(확인 규칙), `수학_숙제.pdf → 문서/…`(미확인 규칙은 미적용), 참고 파일 5개 `[그대로]`. 코드 입력 실행 뒤 참고 파일 manifest 불변, 두 파일 sha256 일치. `rules disable-all` 뒤 "내 정리 규칙이 꺼져 있어 기본 분류를 썼어요."이고 참고 파일은 여전히 `[그대로]` |
| 12 | 참고 파일 보호가 요약에 **정직하게 표시**되는지 | **FAIL(D1)** | 아래 D1. 파일은 보호되지만(데이터 영향 없음) 요약·자세히 보기 어디에도 "참고 파일이라 그대로 둠"이 나오지 않음. `node --test`의 todo 테스트로 남김(실패해도 전체 실패로 세지 않음) |
| 13 | 출력 정직성 | PASS | 요약 "(아직 아무것도 바꾸지 않았어요)", 자세히 보기 "(아직 아무것도 바꾸지 않았어요)", 휴지통 목록 "이 사본들을 휴지통으로 보낼게요(1개, 남길 파일은 그대로): c.txt (같은 내용의 'c copy.txt' 파일은 남겨요)". 안내형 화면 전체에 "영구"·"확보"·"공간"·바이트 표기 없음 → 영구 삭제 메뉴 없음, 휴지통을 확보량으로 표시하지 않음 |
| 14 | 심볼릭 링크 `<tmp>/bin/afo → dist/apps/cli/src/index.js`, `chmod +x`, 직접 실행 | PASS | 첫 줄 `#!/usr/bin/env node`. 링크 직접 실행 `--help` → 0, "가장 쉬운 사용법". 비TTY 인수 없음 → 도움말(0), stderr에 질문 없음. pty에서 인수 없이 링크 실행 → 안내 시작 → 4로 종료 0, 파일 불변. 전역 설치(`npm link`)는 하지 않음 |
| 15 | Windows | NOT-RUN | 이 Mac에서 검증 불가. 테스트는 사유와 함께 skip(`cleanDroppedPath`의 Windows 분기는 기존 단위 테스트만 존재) |

## 결함

### D1 (경미, 표시 정직성) 참고 파일 보호 이유가 안내형 화면에 나오지 않음

- 재현: 참고 폴더 = 작업 폴더로 `suggest-rules <작업 폴더> --json > d.json` → `rules save d.json --select <물리 규칙>` → 작업 폴더에 새 파일 `물리_새보고서.pdf` 추가 → 터미널에서 `afo` → 그 폴더 입력 → `3`.
- 관측: "폴더별로 정리할 수 있는 파일: 0개 / 그대로 둘 파일: 4개(이미 정리된 곳에 있는 파일 등) / 저장된 내 정리 규칙을 적용했어요.", 메뉴 1 "할 일 없음", 자세히 보기는 `[그대로] 물리_새보고서.pdf`처럼 이유 없이 나열.
  규칙을 적용했다는데 새 파일이 옮겨지지 않는 이유(엔진이 v2 프로필의 참고 폴더 안 파일을 모두 `PROTECTED_REFERENCE`로 보호)가 화면에 없습니다. `preview`는 항목마다 `참고한 기존 파일을 보존합니다.` 이유를 보여 주지만 `guided.ts`의 `summaryLines`·`detailLines`는 keep의 이유를 버립니다.
- 영향: 파일은 옮겨지지 않으므로 데이터 영향 없음. 다만 사용자는 "규칙이 안 먹는다"로 오해할 수 있고, 검증 패킷의 "참고 파일 보호가 요약에 정직하게 표시" 조건을 충족하지 못합니다.
- 제안(구현자 판단): 요약에 `참고한 기존 파일이라 그대로 둘 파일: N개`를 별도 줄로, 자세히 보기의 `[그대로]`에 이유를 붙이기.
- 별도 관찰(엔진, 이 패킷 범위 밖): 참고 폴더 안에 **규칙 저장 뒤 새로 들어온 파일**도 "참고한 기존 파일"로 보호됩니다. ARCHITECTURE.md의 "참고한 기존 파일" 표현보다 넓지만 보수적인 방향(옮기지 않음)입니다. 의도인지 #18 담당이 확인할 것.

## 문구 관찰(OBS — 판정 아님)

| # | 화면 | 관찰 |
| --- | --- | --- |
| O1 | 요약 "직접 확인이 필요한 파일: 1개 — 확장자가 없어 종류를 판단하지 않았습니다. 기타/검토 대상입니다. 1개" | 엔진의 이유 문장(합니다체, 두 문장)에 "1개"가 바로 붙어 어색함. 이유가 여러 개면 한 줄이 매우 길어짐. 짧은 이유 라벨(예: "확장자 없음 1개")이 읽기 쉬움 |
| O2 | 전체 | 안내형 화면은 해요체, 재사용한 엔진·grant·undo 문구는 합니다체("…분석 대상이 아닙니다.", "되돌릴 후보 5개…옮깁니다", "아무것도 바꾸지 않았습니다.")라 한 화면 안에서 말투가 섞임 |
| O3 | `afo undo` | "가장 최근에 정리한 기록을 되돌려요: 2026-10-30T04:20:44.908Z (실행 ID 05d4…)" 바로 다음 줄 "AFO 되돌리기 확인 — 실행 05d4… (2026-10-30T04:20:44.908Z)"로 실행 ID·시각이 두 번 나옴. 시각이 UTC ISO 형식이라 일반 사용자에게 낯섦(한국 시각 아님). 항목 앞의 16자리 작업 ID도 일반 사용자에게는 불필요한 정보 |
| O4 | 틀린 코드·빈 코드·3회 실패 | "AFO 오류: 코드가 맞지 않아 실행하지 않았어요." — 사용자가 고른 정상 취소·거부에도 "오류" 접두가 붙음. 해요체 문장 앞의 "AFO 오류:"가 어색 |
| O5 | 중복 예시 | "남길 파일 'c copy.txt', 휴지통 후보 'c.txt'" — 이름상 원본처럼 보이는 `c.txt`를 휴지통 후보로, 사본 이름(`… copy`)을 남길 파일로 제안(엔진의 남길 파일 선택 규칙). 안내형 화면에서는 남길 파일을 바꿀 방법이 없어 사용자가 당황할 수 있음 |
| O6 | 요약 "같은 내용의 중복 파일: 1묶음(지울 수 있는 사본 1개)" | 실제 동작은 휴지통 보내기인데 "지울 수 있는"이라 영구 삭제로 읽힐 여지. "휴지통으로 보낼 수 있는 사본"이 동작과 일치 |
| O7 | 메뉴 | 1에는 "(되돌릴 수 있어요)"가 있지만 2에는 되돌리기 안내가 없음. "afo undo로는 되돌리지 않아요 / 휴지통에서 되살릴 수 있어요"는 실행 **뒤** 결과에서야 나옴. 메뉴나 코드 입력 전 목록에 한 줄 있으면 좋음 |
| O8 | Ctrl+C | "AFO: 취소했습니다(Ctrl+C). 실행 전이었다면 아무것도 바꾸지 않았습니다." — 안내형 질문 단계는 항상 실행 전이므로 "실행 전이었다면"이 불필요하게 불확실하게 들림 |
| O9 | 분석 중 Ctrl+C | "AFO 오류[CANCELLED]: 분석을 취소했습니다." — 질문 중 Ctrl+C 문구와 다르고 영문 오류 코드가 그대로 노출됨 |
| O10 | 첫 질문 | "끌어다 놓고 Enter" 안내만 있고 경로를 직접 입력·붙여넣어도 된다는 말은 없음(동작은 함). 드래그가 안 되는 터미널 사용자에게 한 마디 있으면 좋음 |
| O11 | 결과 "정리를 마쳤어요. (실행 ID 05d4e692-76e1-…)" | 전체 UUID 노출. `afo undo`가 ID 없이 되므로 일반 사용자에게는 생략하거나 앞 8자로 충분 |
| O12 | 메뉴 1 "파일 5개" | 중복 묶음의 두 파일(원본·사본)도 함께 옮겨 같은 목적지 폴더에 나란히 들어감. 2를 먼저 하라는 순서 안내는 없음(동작 오류는 아님) |

## 미검증

- Windows 실물: NOT-RUN(이 Mac에서 불가). `\ ` 이스케이프를 Windows에서 풀지 않는 분기, PowerShell/cmd의 드래그 형식, Windows 콘솔의 Ctrl+C는 확인하지 않았습니다.
- Linux: 테스트는 python3 pty가 있으면 실행되지만 이 기록에서는 실행하지 않았습니다.
- macOS Terminal.app·iTerm2에서 사람이 실제로 Finder 폴더를 끌어다 놓은 입력: 드래그가 만드는 문자열은 pty로 같은 형식을 입력해 대신했습니다(앱별 실제 드래그 문자열은 미확인).
- 분석 중 Ctrl+C(시나리오 8)는 수동 1회만 실행했고 자동 테스트에는 넣지 않았습니다(타이밍 경쟁·대용량 합성 파일).
- 실행(`executeBatch`) 도중 Ctrl+C, 실행 중 파일 변경, `npm link` 전역 설치 경로는 이 검증 범위 밖입니다(전역 설치 금지).
- 휴지통 안의 실제 위치(가짜 HOME의 `.Trash`인지 사용자 휴지통인지)는 휴지통을 읽지 않는 규칙 때문에 확인하지 않았습니다.

## 재검증(b1ae8ff)

2026-10-30. 대상 `origin/feat/cli-guided` @ `b1ae8ff87783be64765af28d37cd2ef0f050d13c`(6d0cdac 병합 포함, 6fccce4 이후 변경 1cde928·b1ae8ff).
같은 환경(macOS 27.0.1, Apple M5, Node v24.18.0, Python 3.13.9, 실제 pty, 합성 temp 폴더·가짜 HOME·temp `AFO_STATE_DIR`, `TZ=Asia/Seoul`). 제품 코드는 고치지 않았습니다.
`tests/verify-cli-guided.test.ts`에 R-K1·R-K2·R-U1·R-U2·R-U3·R-W 6개를 추가했습니다(파일 전체 17개).
참고: 구현자가 b1ae8ff에서 이 검증 파일의 기존 기대 문구(프롬프트·undo 화면·D1 todo 해제 등)를 새 문구에 맞춰 고쳤습니다. 각 변경이 새 동작과 맞는지 다시 읽어 확인했고, 추가 사례로 독립 확인했습니다.

```sh
git fetch origin && git checkout -B verify-cli-guided-2 origin/feat/cli-guided   # HEAD b1ae8ff
rm -rf dist && npm run typecheck && npm test
AFO_REAL_TRASH_TEST=1 node --test --test-name-pattern="real OS trash and keeps" dist/tests/verify-cli-guided.test.js   # 실제 휴지통 1회
python3 -I <scratch>/cancel_scan.py   # 분석 중 Ctrl+C(수동 pty)
```

- `npm run typecheck`: 오류 없음. `npm test`: **tests 459 / pass 448 / fail 0 / skipped 11 / todo 0**. skipped 11은 환경 조건 테스트(실제 휴지통·디스크 이미지).
- 실제 휴지통 1회: pass. 새 keeper 규칙대로 `afo-test-guided-pty-… copy.txt`(사본 표시)가 휴지통으로 가고 사본 표시 없는 파일이 남았습니다. 휴지통은 읽거나 비우지 않았습니다.
- 끝난 뒤 `$TMPDIR/afo-verify-guided-*` 잔여 0개.

### 항목별 판정

| # | 항목 | 결과 | 근거 |
| --- | --- | --- | --- |
| K1 | keeper 규칙(엔진, 손으로 쓴 기대표 17묶음 × 모든 입력 순서) | PASS | 보호 → 사본 표시 없음 → 얕은 경로 → 짧은 이름 → 경로순. Windows 영문 `- Copy`·`- Copy (2)`, 한글 `- 복사본 (2)`, Finder `복사본 2`·`copy 2`, `archive (1).tar.gz`, `v1.2 (1).pdf`, 사본처럼 보이지만 아닌 `copy.txt`·`사본.txt`·`(1)보고서.pdf`·`복사본.pdf`·`photocopy.pdf`·`a(1).pdf`·`a (0)`/`a (100)`·`file.copy.txt`, NFD 이름, 둘 다 사본 표시면 경로순. 5개 묶음 120가지 순서 모두 같은 keeper |
| K2 | CLI 실제 파일: `plan --delete-duplicates all --json`, 안내형 메뉴 2 목록 | PASS | 휴지통 작업 = 손으로 쓴 표(`보고서 (1).pdf`·`받은/보고서 copy.pdf` ← `보고서.pdf`, `archive (1).tar.gz` ← `archive.tar.gz`, `copy (1).txt` ← `copy.txt`, 얕은 `원본.hwp`가 남고 `정리함/원본.hwp`가 후보). keeper를 `--delete-file`로 직접 고르는 것은 사본이 남으므로 허용(0). 안내형 목록 "보고서 (1).pdf (같은 내용의 '보고서.pdf' 파일은 남겨요)". 파일 불변 |
| K3 | 보호 파일 우선(CLI 경로) | PASS(관찰 K-O1) | 참고 폴더 `정리함/`의 규칙을 저장하면 `정리함/원본.hwp`는 보호되고 **해시 자체를 하지 않으므로**(analyzeRoot가 보호 경로 제외) `원본.hwp` 묶음이 사라짐 — 어느 쪽도 휴지통 후보가 아님. "보호 파일이 keeper" 분기는 CLI에서는 나타나지 않고 엔진 단위에서만 확인됨 |
| K4 | 웹 공용 defaults와 충돌 | PASS | `packages/engine/src/defaults.ts`·`classify.ts`·`firebase/`는 6fccce4 이후 변경 없음(`git diff --stat` 빈 결과). 웹 코드에는 중복·keeper 로직이 없음. `tests/browser-defaults.test.ts` 통과 |
| U1 | undo의 빈 폴더 제거 — 정상·중첩 | PASS | `--move a.pdf=깊은/폴더/안` 등으로 만든 실행 기록 `createdDirectories` = 손으로 쓴 9개(원래 있던 `문서/` 제외). undo 뒤 `깊은/폴더/안`→`깊은/폴더`→`깊은` 3개만 제거 |
| U2 | 원래 있던 폴더(빈 것 포함) 보존 | PASS | 미리 만든 빈 `문서/`(이동 목적지로 쓰였다가 다시 빈 상태)·`빈폴더/` 모두 그대로 |
| U3 | undo 전 사용자가 새 폴더에 파일·하위 폴더·`.DS_Store`를 넣음 | PASS | `영상/내 메모.txt`, `음악/앨범/`, `DS폴더/.DS_Store` 보존, 세 폴더 "안에 다른 항목이 있어 그대로 뒀어요" |
| U4 | 새 폴더를 같은 이름의 다른 폴더로 교체 / 바깥을 가리키는 심볼릭 링크로 교체 | PASS | `설치/`(다른 inode) 보존, `이미지` 링크 보존("정리할 때 만든 폴더가 아니게 바뀌어 그대로 뒀어요"), 링크 대상 쪽 manifest 불변. 링크 경로의 `b.jpg`는 되돌리지 않음(종료 3) |
| U5 | 부분 실패 undo에서 비어 있지 않은 폴더 유지 | PASS | 원래 자리에 사용자 새 `x.zip` → 되돌리지 않음, `압축/x.zip`과 `압축/` 유지, 원래 자리 파일 불변. 전후 manifest 차이 = 되돌린 6개 이동 + 제거된 3개 폴더뿐 |
| U6 | `createdDirectories` 변조: `..`, `영상/../..`, `''`, `.`, 루트 밖 절대 경로 | PASS | 실행 기록이 계약(RelativePathSchema)에 맞지 않아 읽지 않음 → undo 전체 거부, 아무것도 지우거나 옮기지 않음. `afo undo`는 "읽을 수 없는 실행 기록 1개는 건너뛰었어요" + 되돌릴 기록 없음(0), `undo <ID> --confirm`은 1 |
| U7 | 변조: 루트 안 링크를 거친 경로 `link/empty`, 링크 자체 `link`(둘 다 바깥 폴더의 실제 dev/ino), 만든 폴더의 틀린 inode | PASS | 파일은 되돌리고 폴더는 보존: `link/empty` "지우지 못해 그대로 뒀어요(LINK_REJECTED)", `link`·`영상` "…아니게 바뀌어 그대로 뒀어요". 바깥 폴더·링크·원래 빈 폴더 불변 |
| U8 | 이전 형식 실행 기록(필드 없음) | PASS | undo 가능(0), 파일 원상, 만든 빈 폴더(`영상/`·`문서/`)는 남김. 다른 실행이 같은 새 폴더에 파일을 넣은 뒤 첫 실행 undo → 폴더 유지("안에 다른 항목이 있어 그대로 뒀습니다") |
| U9 | (패킷 밖) 원래 있던 **빈** 폴더를 그 실제 dev/ino로 `createdDirectories`에 위조 | 관찰 R1 | 그 빈 폴더가 **제거됨**(파일은 하나도 바뀌지 않음). 아래 R1 |
| W1 | D1 해결(유지 이유 표시) | PASS | 요약 "그대로 둘 파일: 4개 — 참고 폴더 보호 4", 자세히 보기 "[그대로] 물리_새보고서.pdf — 참고 폴더 보호". 이전 D1 → **해결** |
| W2 | 사용자 취소에 "AFO 오류:" 없음, 종료 코드 유지 | PASS | 틀린 코드 4, 빈 코드 4(정리·휴지통·undo), 폴더 3회 1, 번호 3회 2, Ctrl+C 130 — 모두 접두어 없음. 분석 중 Ctrl+C(수동)도 "그만뒀어요(Ctrl+C). 아무것도 바꾸지 않았어요."(이전 O9 해결) |
| W3 | 해요체 | PASS(관찰 W-O1) | 이 테스트가 모은 안내형·undo 화면 전체에 "…니다" 문장 끝 없음. 다만 변환 함수가 `다릅니다`·`다룹니다`·`둡니다`류를 바꾸지 못함(W-O1) |
| W4 | 휴지통 메뉴 안내, 중복 사본 힌트, 짧은 실행 ID | PASS | "2) 중복 파일을 휴지통으로 보내기(휴지통에서 다시 꺼낼 수 있어요. afo undo로는 되돌리지 않아요) — 사본 1개", 1) 아래 "같은 내용의 사본 1개도 함께 옮겨요. 먼저 2)로 정리할 수도 있어요.", 결과 "(실행 ID 8자)" + "전체 실행 ID와 기록은 afo runs로 볼 수 있어요." |
| W5 | 짧은 `afo undo` 화면 | PASS | "10월 30일 오후 1:46에 정리한 파일 5개를 원래 자리로 되돌릴까요?"(실행 기록 startedAt + 9시간을 손으로 계산한 값과 일치), 16자리 작업 ID·ISO 시각·전체 실행 ID 없음, 결과 "되돌렸어요: 5개 · 건너뜀 0 / 정리할 때 만든 빈 폴더 3개도 지웠어요." |

이전 판정 갱신: 시나리오 12(D1) FAIL → **PASS(해결)**. 시나리오 5의 "빈 폴더는 남음"은 새 동작(이 실행이 만든 빈 폴더 제거)으로 바뀌어 PASS 유지(파일·폴더 manifest가 처음과 동일). 이전 문구 관찰 O1(이유 문장+개수)·O3(undo 화면 중복·UTC·작업 ID)·O4(“AFO 오류”)·O5(사본 이름을 남김)·O6(“지울 수 있는”)·O7(휴지통 안내)·O8·O9(Ctrl+C 문구)·O10(붙여 넣기 안내)·O11(전체 UUID)·O12(사본도 함께 옮김)는 b1ae8ff에서 반영된 것을 화면으로 확인했습니다. O2(말투 섞임)는 대부분 해결, 남은 것은 W-O1.

### 결함·위험

- **R1(낮음, 상태 폴더 무결성)**: 실행 기록 `runs/<id>.json`에는 승인 기록과 달리 MAC이 없어, 상태 폴더에 쓸 수 있는 누군가가 `createdDirectories`에 **원래 있던 빈 폴더**의 경로와 실제 dev/ino를 적으면 undo가 그 빈 폴더를 `rmdir`합니다. 재현: R-U2의 마지막 사례(`빈폴더`, `t.diagnostic`에 `REMOVED`). 영향은 빈 폴더 1개(`rmdir`은 재귀하지 않고 파일은 지우지 않음)이며 상태 폴더 쓰기 권한이 전제입니다. 출시 차단은 아니라고 판단하지만, 원하면 실행 기록에 승인과 같은 MAC을 붙이거나 undo 때 저널의 mkdir 기록과 대조할 수 있습니다.
- 데이터 손실·승인 밖 이동/삭제·덮어쓰기·루트 이탈은 발견하지 못했습니다.

### 문구 관찰(재검증, OBS)

| # | 관찰 |
| --- | --- |
| K-O1 | 보호(참고) 파일과 같은 내용의 일반 파일은 중복 후보로 아예 나오지 않습니다(보호 파일을 해시하지 않음). 안전한 방향이지만 "내 정리 폴더에 이미 있는 사본"을 치우고 싶은 사용자에게는 중복 0묶음으로 보입니다 |
| W-O1 | `haeyo()`가 `ㅂ니다` 활용 중 목록에 없는 것(`다릅니다`, `다룹니다`, `둡니다`, `가집니다`, `넘습니다`)을 바꾸지 못합니다. 안내형 화면에 올 수 있는 예: 결과 상세 "이동한 파일의 내용이 예상과 다릅니다.", "일반 파일만 다룹니다(폴더 제외)." (서비스·CLI 문구 209개를 변환해 본 결과 남은 것 22개, 대부분 계약·변조 오류) |
| W-O2 | undo 화면의 폴더 보존 이유에 영문 코드가 그대로 나옵니다: "link/empty — 지우지 못해 그대로 뒀어요(LINK_REJECTED)." |
| W-O3 | undo 목록 순서가 경로순이 아니라 작업 ID(해시)순이라 실행마다 섞여 보입니다("영상/clip.mp4, 문서/a.pdf, 문서/c copy.txt …") |
| W-O4 | 이전 형식 실행 기록을 `afo undo`로 되돌리면 짧은 화면에는 빈 폴더가 남는다는 말이 없습니다(`undo <ID>` 화면의 참고 문구에만 있음) |
| W-O5 | 메뉴 2 줄이 길어(괄호 안 두 문장 + 개수) 80칸 터미널에서 줄바꿈되고 개수가 맨 끝으로 밀립니다 |
| W-O6 | 1) 아래 "먼저 2)로 정리할 수도 있어요"의 "정리"는 2)가 휴지통 보내기라 약간 모호합니다("먼저 2)로 사본을 휴지통에 보낼 수도 있어요") |
| W-O7 | 부분 실패 undo(종료 3) 화면에 다음 행동 안내(예: 남은 파일을 직접 옮기거나 afo runs로 확인)가 없습니다 |
| W-O8 | Finder가 폴더를 열면 `.DS_Store`가 생기므로, 정리 뒤 Finder로 새 폴더를 열어 본 사용자는 undo 때 그 폴더가 "안에 다른 항목이 있어" 남습니다(동작은 안전, 기대와 다를 수 있음) |

### 미검증(재검증)

- Windows 실물(`- 복사본 (N)` 실제 Explorer 이름, `rmdir` 동작): NOT-RUN. Linux pty 미실행.
- 실행 중 Ctrl+C 뒤 "중간에 멈췄어요" 결과 화면: 실행 시간이 짧아 pty로 재현하지 않았습니다.
- 빈 폴더 제거의 검사-`rmdir` 사이 경쟁(다른 프로세스가 그 순간 폴더를 바꿈)은 재현하지 않았습니다. `rmdir`은 비어 있지 않거나 링크면 실패하므로 파일 손실 경로는 보이지 않습니다.

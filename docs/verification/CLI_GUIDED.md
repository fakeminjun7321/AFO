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

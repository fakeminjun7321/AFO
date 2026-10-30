# 기본 분류표 default-3·안내형 "종류를 모르는 파일" 독립 검증 — 실제 pty

상태: **verifier 독립 검증 기록**. 2026-10-30. 대상은 `origin/feat/unknown-files`의 기본 분류표(`packages/engine/src/defaults.ts`, `classify.ts`, `CLASSIFICATION_VERSION = default-3`)와
안내형 `afo`의 메뉴 1 뒤 "종류를 모르는 파일" 질문(`apps/cli/src/guided.ts`), 웹사이트 `/preview`의 같은 파일 사용(`apps/website/src/features/local-preview/preview.ts`)입니다.
제품 코드(`packages/`, `apps/`)는 고치지 않았습니다. 추가한 파일은 `tests/verify-unknown-files.test.ts`와 이 문서뿐입니다.

## 보고 양식

```text
Issue / PR / Commit: default-3 분류표 + 안내형 종류를 모르는 파일 / PR 없음(검증만) / 기준 origin/feat/unknown-files 153abe2809dafdccdbbbcb8af351e925ada13275 (origin/main 4d7836c 위)
Environment: macOS 27.0.1 (26A434), Apple M5 (arm64), Node v24.18.0, Python 3.13.9(pty 표준 모듈) — physical(이 Mac), 합성 temp 폴더만
Fixture and baseline manifest: 테스트마다 mkdtemp(os.tmpdir(), 'afo-verify-unknown-') 아래 home/(가짜 HOME), state/(AFO_STATE_DIR), home/정리 대상/(작업 폴더),
  home/옆 폴더/keep.xyz(루트 밖 감시용). 실제 홈 안이면 setup이 거부. 테스트 종료 시 base 삭제
  manifest는 테스트 파일 안에서 직접 계산(lstat bigint, 링크 미추적: 상대 경로·종류·크기·mtimeNs·sha256). 루트 밖은 home/ 전체(작업 폴더 제외)를 같은 방식으로 대조
  기대 분류는 손으로 쓴 표 104개 이름(제품 표 categoryExtensions를 import하지 않음). 저장 수정은 state/profiles/active.json을 JSON으로 직접 읽어 대조
Steps or exact commands: 아래 "실행한 명령"
Observed files / hashes / journal / exit status: 항목별 표
Passed / Failed / Not run: 검사 항목 16행 PASS 13 / FAIL 3(D1 긴 이름 늦은 거부, D2 충돌 안내 없음·잘못된 문구, D3 '=' 이름) / NOT-RUN 1(Windows)
Verification level: Physical-device-verified(macOS, 이 Mac, 실제 pty, 합성 폴더) / Windows NOT-RUN(CI 대기) / 웹 /preview는 단위(ad hoc) 수준
Not verified and reason: "미검증" 절
Release blocker and unblock condition: 데이터 손실·승인 밖 이동/삭제·덮어쓰기·루트 이탈은 발견하지 못함. 출시 차단 결함 없음(이 범위). D1·D2는 수정 권장, D3는 낮음
```

## 실행한 명령

```sh
git fetch origin && git checkout -b verify-unknown-files origin/feat/unknown-files   # HEAD 153abe2
npm ci --ignore-scripts --no-audit --no-fund
rm -rf dist && npm run typecheck && npm test
# 웹사이트
(cd firebase && npm ci) && (cd apps/website/server && npm ci) && (cd apps/website && npm ci && npm run build:shared && npm test && npm run build)
# 웹 makePreview ad hoc: preview.ts를 scratch로 복사(defaults 경로만 절대 .ts로 바꿈) 후 node --experimental-strip-types로 손 표 104개 대조
```

- 기준(검증 테스트 추가 전) `npm test`: tests 467 / pass 456 / fail 0 / skipped 11.
- 추가 후 `rm -rf dist && npm run typecheck && npm test`: typecheck 오류 없음, **tests 480 / pass 466 / fail 0 / skipped 11 / todo 3**.
  이 파일은 13개(통과 10, todo 3 = D1·D2·D3 — 실행되며 현재 실패하지만 전체를 실패시키지 않음). skipped 11은 기존 환경 조건 테스트입니다.
- 웹사이트 `npm run build:shared` 성공, `npm test` **tests 7 / pass 7 / fail 0**, `npm run build` 성공. 웹 테스트 7개는 분류표를 직접 검사하지 않으므로 아래 ad hoc 대조를 따로 했습니다.
- 웹 ad hoc: `makePreview`(규칙 없음)로 손 표 104개 → **불일치 0**(이동 제안 = `<분류>/<이름>`, 확인 필요 = review).
- 끝난 뒤 `$TMPDIR/afo-verify-unknown-*`, 탐색용 `$TMPDIR/afo-probe-*`·`afo-gprobe-*` 잔여 0개.

## 항목별 결과

| # | 검사 | 결과 | 근거 |
| --- | --- | --- | --- |
| 1 | 손 표 104개: `defaultCategory`(웹 fallback) = `classifyFile` = 기대값, 확장자 = `path.posix.extname` 소문자 (U1) | PASS | 대소문자(`Report.PDF`, `BIG.TAR.BZ2`, `stats.R`, `TYPES2.TS`), 새 분류 디자인·글꼴·전자책·코드·데이터 각 2개 이상 |
| 2 | 위장형 이중 확장자 | PASS | `report.pdf.exe`·`REPORT2.PDF.EXE`·`photo.jpg.scr`·`letter.doc.js`·`invoice.pdf.lnk`·`clip2.mp4.ts`·`note.txt.bat`·`x.gz.exe`·`y.zip.exe` → COMPOUND_EXTENSION(확인 필요) |
| 3 | 압축 바깥·`.tar.*` | PASS | `dump.sql.gz`·`table.csv.bz2`·`photos.jpg.zip`·`setup.exe.zip`·`tool.exe.7z`·`data.json.xz`·`old.v1.2.zip`·`.tar.gz/.zst/.xz/.BZ2`·`.TGZ` → 압축. `a.tar.tgz` → COMPOUND(문서대로) |
| 4 | 다운로드 중·제외 확장자·숫자 이름 | PASS | `.mp4.part`·`.sql.gz.part`·`.crdownload`·`.download`·`.PART`·`.CrDownload`·`doc.pdf.download` → INCOMPLETE_DOWNLOAD. `ts m bin dat tmp lnk url webloc alias` → UNKNOWN. `12345`·`README`·`메모` → NO_EXTENSION. `2024.10.30`·`v1.2.3` → UNKNOWN(O4) |
| 5 | CLI `preview --json`에 같은 104개 + 점 이름 3개 (U2) | PASS | 실제 스캔·분석 결과 action/destination/reasonCode가 손 표와 일치, `classificationVersion: default-3`. `.env`·`.hidden.pdf`·`.config.json`은 `skipped`에 `HIDDEN`. 폴더 불변 |
| 6 | 웹 `/preview` 같은 파일 사용 (U1b + ad hoc) | PASS | `preview.ts`가 `packages/engine/src/defaults`의 `defaultCategory`를 import, 표 사본 없음, 다섯 이유 문장 모두 있음. ad hoc 104개 불일치 0. 차이 1건은 O8 |
| 7 | 참고 폴더에서 배운 규칙(`.part`→받는중 확인됨)이 다운로드 중·위장형에 적용되지 않음 (U1c) | PASS | `movie.mp4.part`·`NEW.PART` → INCOMPLETE_DOWNLOAD, `report.pdf.exe` → COMPOUND, `new.exe` → PERSONAL_RULE(설치함) |
| 8 | pty 1) 모두 '기타' → 실제 이동 → 새 프로세스 `afo undo` (U3) | PASS | 종료 0, 옮김 5. `a.pdf→문서/`, `data.xyz`·`sub/more.XYZ`·`메모`·`2024.10.30 → 기타/`(sha256·크기·mtimeNs 동일). `.part`·`.crdownload`·`.env`·`report.pdf.exe` 항목 그대로. 루트 밖 불변. undo 뒤 manifest(파일·폴더) **처음과 동일**: `기타/`·`문서/` 제거, 원래 있던 `sub/` 유지 |
| 9 | pty 2) 나쁜 폴더 이름 15개 (U4): `.숨김` `..` `/abs/x` / `C:\x` `a\b` `CON` / `nul` `aux.txt` `기타/../..` / `../../탈출` `./x` `a//b` / `abc.` `a:b` `a*b` | PASS | 15번 모두 "그 이름은 폴더로 쓸 수 없어요", 확장자마다 3번째 뒤 "'.ea' 파일 1개는 그대로 둘게요." 공백만 입력은 Enter와 같이 그대로 두기. "다음에도" 질문·코드 없음, "옮길 파일이 없어요." 0. 파일·루트 밖 불변, approvals/runs/journal/profiles 없음 |
| 10 | NUL 문자 (U7, `runCli` io — pty line discipline으로는 NUL을 그대로 보낼 수 없음) | PASS | `a\0b`, `\0`, `기타\0/x` 거부 3회 → 그대로 둘게요. 파일 불변 |
| 11 | 아주 긴 이름(300자 한 단계) (U7b, U7b-D1) | **FAIL (D1)** | 질문에서 받아들이고 "다음에도"까지 묻는다. 실행 때 `ENAMETOOLONG`로 실패(종료 3, "예상하지 못한 오류예요(ENAMETOOLONG)"). 파일은 그대로(데이터 영향 없음) |
| 12 | 입력 폴더 = 이미 있는 **파일** 이름, `기타`라는 파일이 있을 때 1), 같은 이름 충돌·기존 목적지 (U5) | PASS(안전) | 덮어쓰기 없음: `notes.pdf.exe`(파일) 유지·`d.xyz` 그대로, 파일 `기타` 그대로(폴더로 바뀌지 않음), `a/s.xyz`·`b/s.xyz` 둘 다 그대로, 기존 `기타/t.qqq` sha256 동일. 알려진 파일만 이동 |
| 13 | 같은 상황의 화면 안내 (U5-D2) | **FAIL (D2)** | 아래 D2. 약속한 파일이 빠진 이유를 말하지 않거나 사실과 다른 문구 |
| 14 | "다음에도" y / N / 확장자 없음 / 비ASCII 확장자, 저장 뒤 Ctrl+C·빈 코드 (U6) | PASS | `.qqq` N → 저장 없음, `.xyz` y → `active.json` 수정 1개 `{keyword, .xyz, null} → 자료`(뒤 `/` 정리됨). 확장자 없음·`.한글`은 질문 없음(O5). 코드에서 Ctrl+C → 130, 파일·approvals/runs/journal 불변, 저장은 남음(docs/CLI.md "저장은 남습니다"와 일치, 문구는 O1). 새 프로세스 `preview --json`: `NEW.XyZ` → `자료/NEW.XyZ` SAVED_CORRECTION, `x.QQQ` UNKNOWN, `노트` NO_EXTENSION, `z.xyz.part` INCOMPLETE. `rules list`에 `.xyz → 자료`. 같은 폴더 두 번째 안내형: `.xyz`는 더 묻지 않고 이동 계획, 빈 코드 → 4, 파일 불변 |
| 15 | 이름에 `=`가 있는 파일 (U7c-D3) | **FAIL (D3)** | 아래 D3. 파일 변경 없음 |
| 16 | 기존 테스트 기대값 변경 검토(diff) | PASS | 아래 절 |
| — | Windows | NOT-RUN | 이 Mac에서 검증 불가(CI 대기) |

## 결함

### D1 — 255바이트 넘는 폴더 이름을 질문에서 거부하지 않음 (낮음~중간, 데이터 영향 없음)

재현: 종류를 모르는 파일 `d.xyz`가 있는 합성 폴더에서 `afo` → `1` → `2` → `a`×300 → `N` → 코드 입력.
관찰: 폴더 이름을 받아들이고 계획에 `d.xyz → aaa…/d.xyz`를 보여 준 뒤, 실행에서 "옮김 1 · 건너뜀 0 · 실패 1 / d.xyz — 예상하지 못한 오류예요(ENAMETOOLONG)." 종료 3.
`y`로 답하면 같은 이름이 저장 수정으로 남아 이후 실행마다 실패합니다. 원인: `RelativePathSchema`/`TargetDirectorySchema`에 경로 단계별 길이(바이트) 제한이 없음(`--move`도 같음).
기대: 질문 단계에서 "그 이름은 폴더로 쓸 수 없어요"로 다시 묻기. 테스트 `U7b-D1`(todo).

### D2 — 충돌로 계획에서 빠진 종류를 모르는 파일을 안내형 화면이 설명하지 않음 (중간, 출력 정직성)

재현 A: 확장자 없는 **파일** `기타`와 `e.xyz`, `sub/f.qqq`만 있는 폴더 → `afo` → `1` → `1`.
관찰: "종류를 모르는 파일 3개를 '기타' 폴더로 옮기는 계획을 만들게요." 뒤 결과가 "**살펴보는 사이 파일이 바뀌어** 할 일이 없어졌어요. 아무것도 바꾸지 않았어요."(종료 0). 파일은 바뀌지 않았고, 실제 이유는 `기타`가 파일이라 목적지 충돌입니다.
재현 B: `a/s.xyz`, `b/s.xyz`, `t.qqq`, `기타/t.qqq`, `k.pdf` → `1` → `1`: "4개를 '기타' 폴더로 옮기는 계획을 만들게요." 뒤 계획은 `k.pdf` 1개뿐이고, 빠진 4개의 이유(같은 이름이 겹침·목적지에 같은 이름 파일)는 어디에도 나오지 않습니다.
재현 C: 2)에서 폴더 이름으로 기존 파일 이름(`notes.pdf.exe`)을 입력 → `d.xyz`가 계획에서 조용히 빠짐.
같은 입력의 비대화형 `plan --move …`는 "[검토 필요] 2개: 여러 파일의 목적지가 같습니다…" 등으로 이유를 보여 줍니다. 안전 동작(덮어쓰기 없음)은 맞습니다. 테스트 `U5-D2`(todo).

### D3 — 파일 이름에 `=`가 있고 그 앞부분이 다른 파일 이름과 같으면 1)·2)가 내부 `--move` 오류로 멈춤 (낮음)

재현: 확장자 없는 `x`와 `x=y.xyz`가 있는 폴더 → `afo` → `1` → `1`.
관찰: "AFO 오류: --move의 파일을 이 폴더에서 하나로 찾을 수 없습니다: x=y.xyz=기타", 종료 1. 사용자는 `--move`를 입력한 적이 없습니다. 파일 변경 없음.
원인: 안내형이 선택을 `<경로>=<폴더>` 문자열(`--move`)로 조립하고 `analyzeTarget`이 모든 `=` 위치를 시도해 두 파일이 맞음. 테스트 `U7c-D3`(todo).

## 문구 관찰(일반 사용자 관점)

- O1. 저장 뒤 코드에서 Ctrl+C / 빈 코드: "그만뒀어요(Ctrl+C). **아무것도 바꾸지 않았어요.**" / "코드를 입력하지 않아 실행하지 않았어요. 아무것도 바꾸지 않았어요." — 바로 앞에서 규칙을 저장했으므로 "파일은 바꾸지 않았어요(저장한 규칙은 남아 있어요)"가 정확합니다. 문서(docs/CLI.md)는 저장이 남는다고 정확히 적고 있습니다.
- O2. 3번째 거부 때 "…이 폴더 안의 폴더 이름을 입력해 주세요." 직후 "…그대로 둘게요."가 나옵니다. 입력하라고 한 뒤 묻지 않습니다.
- O3. 거부 이유 "(숨김 폴더·..·절대 경로·특수 문자는 안 돼요)"에 `CON`·`nul` 같은 예약 이름, 끝의 점(`abc.`)은 없습니다. 거부 자체는 맞습니다.
- O4. 날짜형 이름 `2024.10.30`이 "**.30** 1개(예: 2024.10.30)"로 묶이고 2)에서는 "다음에도 '.30' 파일은…"을 물을 수 있습니다. 확장자 없는 파일로 보는 편이 사용자에게 자연스럽습니다.
- O5. 저장 조건으로 쓸 수 없는 확장자(`.한글`, 17자 이상 등)는 "다음에도" 질문 없이 넘어가며 이유를 말하지 않습니다(확장자 없음은 문서에 적혀 있음).
- O6. 이미 `기타/` 안에 있는 종류를 모르는 파일(`기타/t.qqq`)도 "종류를 모르는 파일 N개"와 "N개를 '기타' 폴더로 옮기는 계획" 수에 들어갑니다.
- O7. 분류 선택: `.key`(Keynote)는 인증서 개인 키 파일과 같은 확장자, `.obj`는 컴파일 산출물과 같은 확장자입니다. 이동뿐이고 되돌릴 수 있지만 "문서"/"디자인"이 맞지 않을 수 있습니다.
- O8. 웹 `/preview`는 브라우저에 저장한 `.part` 규칙이 있으면 `movie.mp4.part`를 "받는중/"으로 **제안**합니다(ad hoc 확인). CLI는 배운 규칙을 다운로드 중 파일에 적용하지 않습니다(명시 저장 수정만). 웹은 미리보기 전용이라 파일 변경은 없습니다.
- O9. 위장 검사는 안쪽 한 단계만 봅니다: `a.jpg.part.exe` → 설치(바깥 exe, 안쪽 part는 알려진 분류가 아님).
- O10. (코드 읽기) 저장 수정은 이중 확장자에도 적용됩니다(`classify.ts` 주석). 예: `.xyz` 저장 뒤 `report.pdf.xyz`도 그 폴더로 이동 제안. 사용자가 명시한 규칙이므로 의도로 보이며 실행 확인은 하지 않았습니다.
- 좋았던 점: 메뉴 1의 "종류를 모르는 파일 N개(옮길 곳을 물어봐요)", 예시 파일 이름, "다운로드 중일 수 있는 파일 N개(예: …)는 그대로 둬요.", 저장 확인 문구와 `afo rules list/forget` 안내는 짧고 분명했습니다.

## 기존 테스트 기대값 변경 검토

- `tests/cli-guided.test.ts`: 메뉴 1 뒤 새 질문에 빈 답(그대로 두기)을 하나 끼움, Ctrl+C 질문 수 3→4, "할 일 없음" 사례의 `notes`(확장자 없음, 이제 1)을 고를 수 있음)를 `notes.pdf.exe`(위장형, 계속 확인 필요)로 교체. 원래 검사 의도(할 일 없는 메뉴는 고를 수 없음)를 유지합니다.
- `tests/verify-cli-guided.test.ts`: 같은 이유로 `KEEP_UNKNOWN`(Enter) 단계 추가와 `notes` → `notes.pdf.exe`. 기대 이동·결과 수는 바뀌지 않음(`notes`는 여전히 그대로).
- `tests/verify-18-recheck.test.ts`·`tests/rules.test.ts`: `photo.jpg.gz`·`data.tar.zip`·`photo.jpg.zip`·`a.tar.zip`이 COMPOUND → 압축. default-3의 "바깥이 순수 압축이면 압축" 결정과 일치. `report.pdf.exe`·`a.tar.tgz`·`archive.tar.gz.exe`는 계속 COMPOUND로 남아 위장 검사가 약해지지 않았음을 확인.
- `tests/engine.test.ts`·`tests/scanner.test.ts`: 버전 문자열 default-2 → default-3만 변경, 기존 oracle 표는 그대로 통과. (engine 테스트 제목은 아직 "default-2 classification…" — 이름만의 문제)
- `tests/browser-defaults.test.ts`: 비교 이름 5개 추가만, 검사 방식 동일.

## 미검증

- Windows: NOT-RUN(이 Mac에서 검증 불가, CI 대기). Windows 예약명·백슬래시 거부는 스키마 수준에서만 macOS에서 확인했습니다.
- 웹 `/preview`의 실제 브라우저 화면(파일 선택 UI)은 실행하지 않았습니다. `makePreview` 함수를 Node에서 ad hoc로만 대조했습니다.
- pty에서 NUL 바이트 입력은 하지 않았습니다(U7은 `runCli` io 주입).
- 실제 OS 휴지통 경로는 이 변경과 무관해 다시 실행하지 않았습니다.

## 재검증(bd0bd41)

```text
Issue / PR / Commit: D1~D3·O1~O6 수정 재검증 / PR #54(검증만, 병합 안 함) / 기준 origin/feat/unknown-files bd0bd41(eda7eb2 병합 포함)
Environment: macOS 27.0.1 (26A434), Apple M5 (arm64), Node v24.18.0, Python 3.13.9 — physical(이 Mac), 합성 temp 폴더·가짜 HOME·temp AFO_STATE_DIR만
Fixture and baseline manifest: 1차와 같음(같은 테스트 파일의 setup·snap). 새 테스트 R1~R7
Steps or exact commands: git checkout -B verify-unknown-files-2 origin/feat/unknown-files → rm -rf dist && npm run typecheck && npm test → (apps/website) npm run build:shared && npm test
Observed files / hashes / journal / exit status: 아래 표
Passed / Failed / Not run: 재검증 항목 11행 PASS 11 / FAIL 0 / NOT-RUN 1(Windows 실물·pty)
Verification level: Physical-device-verified(macOS, 이 Mac, 실제 pty + io 주입 일부) / Windows NOT-RUN(CI에서 io·비대화형만 실행, pty는 사유와 skip)
Release blocker and unblock condition: 없음(이 범위). 관찰 R-O1~R-O4는 수정 권장 수준
```

- 기준(bd0bd41, 이 커밋의 테스트 변경 전) `npm test`: tests 485 / pass 474 / fail 0 / skipped 11 / todo 0.
- 재검증 테스트 추가 뒤 `rm -rf dist && npm run typecheck && npm test`: typecheck 오류 없음, **tests 493 / pass 482 / fail 0 / skipped 11 / todo 0**.
  이 파일은 21개(1차 13개 + R1~R7·R1b 8개) 모두 통과. 웹사이트 `npm test` 7/7 pass.

| # | 검사 | 결과 | 근거 |
| --- | --- | --- | --- |
| 1 | D1 경계, 안내형 (R1, io로 실제 이동) | PASS | 255바이트 ASCII·한글 85자(NFC 255 B)·한글 85자를 NFD(510 B)로 입력 → 받아들이고 실제로 폴더를 만들어 이동(sha256 동일). 256 B·한글 86자(258 B)·이모지 64개(256 B) → "이름이 너무 길어요(한 단계 255바이트까지)". 250 B×4 단계 → "옮긴 뒤의 전체 경로가 너무 길어요". 거부된 확장자의 파일은 그대로 |
| 2 | D1 공용 스키마 `plan --move` (R1b) | PASS | 한글 85자 목적지는 계획 저장, 256 B는 "--move의 목적지는 …" 오류로 거부·approvals/runs/journal 없음 |
| 3 | 기존 저장 프로필에 256 B 목적지 (R2) | PASS(안전) | `preview`: 경고 "저장된 개인 규칙 프로필이 손상돼 적용하지 않았습니다: 저장된 프로필이 계약과 다릅니다 (profile.corrections.0.targetDirectory). `rules reset`…", `profile.source = corrupt`, 기본 분류. 안내형 2): "저장된 내 정리 규칙 파일이 손상돼 이번 정리에만 적용해요.", "다음에도" 없음. 파일·`active.json` 바이트 불변. 문구는 R-O1 |
| 4 | D2 재현 A: 파일 `기타` + 1) (R3, pty) | PASS | "옮기지 못하는 파일 3개(그대로 둬요): sub/f.qqq, e.xyz, 기타 — '기타'라는 파일이 이미 있어 그 이름으로 폴더를 만들 수 없어요(이름 충돌)" → stdout "옮길 수 있는 파일이 없어요. 아무것도 바꾸지 않았어요." "파일이 바뀌어" 없음. 파일 불변 |
| 5 | D2 재현 B: 같은 이름 충돌 + 기존 목적지 (R3, pty) | PASS | "3개를 '기타' 폴더로 … ('기타' 폴더에 이미 있는 1개는 그대로 둬요)", "t.qqq — 옮길 곳에 같은 이름이 이미 있어요(이름 충돌, 덮어쓰지 않아요)", "a/s.xyz, b/s.xyz — 옮길 곳에서 다른 파일과 이름이 겹쳐요(덮어쓰지 않아요)". 빈 코드 4, 파일 불변 |
| 6 | D3 `x`+`x=y.xyz`, `=`·공백·이모지 조합 (R4, pty; U7c-D3 io) | PASS | `x`, `x=y.xyz`, `a = b 😀.xyz`, `a = b 😀`, `=.qqq`, `k=v`, `k`, `sub dir=1/c d=2.xyz` → 목적지 `자료 = 1 😀/`, `폴더=2/`, `기타/`로 8개 실제 이동(sha256·mtime 동일), 화면에 `--move` 없음. 새 프로세스 `afo undo` 뒤 manifest(파일·폴더) 처음과 동일, 루트 밖 불변 |
| 7 | 첫 분석 뒤 파일 이름이 바뀜 (R6, io) | PASS | 질문 중 `d.xyz`→`d2.xyz` → "분석 중 파일이 바뀌었습니다. 다시 실행하세요." 계획·승인 없음, 이동 없음 |
| 8 | O6 목적지 폴더 안 파일 (R5, pty) | PASS | 2)에서 `자료`·`기타` 선택 시 "'자료' 폴더에 이미 있는 1개는 그대로 둬요." 등, 계획 2개. `자료/x.qqq`·`기타/z.xyz` 바이트·mtime 불변, "옮기지 못하는 파일"로 보고하지 않음 |
| 9 | O1 저장 뒤 멈춤 문구 (R7, U6) | PASS | 이번 실행에서 저장했으면 "코드를 입력하지 않아 실행하지 않았어요. 파일은 바꾸지 않았어요(저장한 규칙은 남아 있어요)." 저장이 없던 실행은 이전 문구 그대로 |
| 10 | O2·O3 거부 이유 (U4 확장) | PASS | 15개 각각 이유 표시: 절대 경로 3(`/abs/x`, `C:\x`, `a:b` — 드라이브 문자로 시작), `..`·`.` 4, 숨김 1, 예약 이름 3, 끝의 점 1, `//` 1, 특수 문자 2. 3번째는 이유와 "그대로 둘게요"가 한 줄 |
| 11 | **회귀**: 나쁜 폴더 이름 15종(U4), 루트 밖 무변경(U3·U4·U5·U6·R4), undo 원상(U3·R4), `.part` 무변경(U3), 웹 표 일치(U1·U1b·U2) | PASS | 1차 테스트 13개 모두 그대로 통과 |
| — | Windows 실물·pty | NOT-RUN | 이 Mac에서 검증 불가 |

### builder가 바꾼 검증 테스트 기대값 판정

- U3: `2024.10.30`이 "확장자 없음 2개(예: 2024.10.30)"로 묶이도록 기대 변경 — O4 수정(숫자로만 된 확장자는 확장자 없음 묶음)과 일치, 이동 결과 기대(`기타/2024.10.30`)·undo 검사는 그대로. **타당**.
- U7b: 300자 이름이 이제 질문에서 거부되므로 답을 `N` → Enter(그대로 두기)로, 종료 3·ENAMETOOLONG 기대 → 종료 0으로 변경. "파일을 잃거나 덮어쓰지 않음" 검사(manifest)는 그대로. **타당**.
- U5-D2·U7b-D1·U7c-D3: todo만 해제, 단언은 바꾸지 않음. **타당**.
- 절차 메모: `tests/verify-*.test.ts`는 verifier 쓰기 범위입니다(세션 역할 규칙). 이번 변경은 내용상 맞지만 다음부터는 verifier에게 넘기는 편이 역할 분리에 맞습니다.

### 이번 커밋의 테스트 수정(Windows CI)

- PR #54 windows-latest에서 U2·U7·U7b·U7b-D1·U7c-D3가 `synthetic base must not be inside the real home`으로 실패(Windows runner의 `os.tmpdir()`가 `C:\Users\runneradmin\AppData\Local\Temp` — 제품 결함 아님).
  → base가 `realpath(os.tmpdir())` 아래면 홈 아래여도 허용, 단 temp 폴더가 홈 자체면 거부, 그 밖에 홈 아래면 계속 거부.
- 같은 파일의 Windows 가정 점검: 자식 프로세스 env의 `PATH`를 `:`로 이어 붙이던 부분을 `path.delimiter`로 바꾸고, Windows에서는 시스템 변수(`SystemRoot` 등)를 유지하며 `USERPROFILE`도 가짜 HOME으로 지정. pty 테스트 8개는 win32에서 "Windows에는 POSIX pty가 없어…" 사유로 skip. manifest 키는 `/`로 직접 이어 붙여 OS와 무관, `chmod`·하드코딩된 `/` 경로 없음.
- 남은 Windows 위험(미검증): R1은 작업 폴더 경로 + 255자 폴더 이름이라 260자를 넘습니다. Node fs는 긴 경로를 처리하지만, Windows CI에서 실패하면 제품의 Windows 긴 경로 처리 결과로 따로 봐야 합니다. U2의 점 이름 HIDDEN 판정도 Windows 스캐너 동작에 따릅니다.

### 재검증 관찰

- R-O1. 손상 처리는 안전합니다(적용 안 함·파일 불변·손상 파일 보존). 다만 안내가 개발자 용어("계약과 다릅니다 (profile.corrections.0.targetDirectory)")이고 "폴더 이름이 너무 길다"는 원인을 말하지 않습니다. 수정 1개 때문에 저장 규칙 전체가 꺼지고, 권하는 해결책 `rules reset`은 전부 지웁니다. 안내형에서는 같은 경고가 분석 때와 계획 때 두 번 나옵니다.
- R-O2. 255바이트 기준은 APFS(UTF-16 255단위: 한글 86자·이모지 64개도 생성됨)보다 엄격합니다. ext4·NTFS 공통 하한이라 보수적이며, 받아들인 이름이 실패하는 경우는 찾지 못했습니다. NFD로 입력한 한글 85자(510 B)는 NFC 기준으로 받아들이며 APFS·NTFS에서는 생성됩니다.
- R-O3. `a:b`는 "절대 경로는 안 돼요"로 안내합니다(Windows에서는 드라이브 상대 경로라 틀린 말은 아님).
- R-O4. 재현 A에서 파일 `기타` 자신도 "'기타'라는 파일이 이미 있어…" 이유로 목록에 나옵니다. 자기 자신을 자기 이름의 폴더로 옮길 수 없다는 뜻이라 사실이지만 조금 어색합니다.
- 전체 경로 1023바이트 사전 검사는 안내형 2)에만 있습니다. `--move`의 깊은 경로는 계획의 DEST_INVALID에 맡깁니다(builder의 `rules.test.ts`가 검사, 이번에 따로 실행 확인하지 않음).

# AFO CLI 사용법과 종료 코드

## 빠른 시작

```sh
curl -fsSL https://raw.githubusercontent.com/fakeminjun7321/AFO/main/install.sh | sh     # 설치(macOS)
irm https://raw.githubusercontent.com/fakeminjun7321/AFO/main/install.ps1 | iex         # 설치(Windows PowerShell)
afo                                                   # 안내에 따라 폴더 정리
afo undo                                              # 가장 최근 정리 되돌리기
afo --version                                         # 설치된 버전
afo update                                            # 최신 정식 릴리스로 업데이트
```

- 설치 스크립트는 GitHub Releases의 단일 실행 파일(Node.js 내장)을 받아 `SHA256SUMS`와 대조한 뒤 macOS `~/.afo/bin/afo`, Windows `%LOCALAPPDATA%\Programs\AFO\afo.exe`에 두고 PATH에 추가합니다. 제거·업데이트는 [README](../README.md#업데이트와-제거)를 봅니다.
- 소스에서 실행할 때는 `npm ci --ignore-scripts && npm run build` 뒤 `node dist/apps/cli/src/index.js`가 `afo`와 같습니다(`npm link`로 전역 연결도 가능). 코드를 고친 뒤에는 `npm run build`만 다시 하면 됩니다.
- `afo`(인수 없음, 터미널에서) 또는 `afo <폴더>`(그 폴더로 바로 시작): 정리할 폴더를 창으로 끌어다 놓거나 경로를 붙여 넣고 Enter → 짧은 분석 요약(파일 수, **정리 후 폴더 트리**(`정리 테스트/` 아래 `├─ 문서/ 3개 (예: a.pdf, b.pdf)`처럼 많은 순 최대 8개 + "… 폴더 N개 더"), 그대로 둘 파일과 확인 필요 파일의 개수·이유의 짧은 이름(`참고 폴더 보호 4 · 이미 정리된 위치 2`, `확장자 없음 1 · 목적지 충돌 2`처럼 이유 코드별), 중복 묶음과 예시(남길 파일·휴지통으로 보낼 수 있는 사본), 개인 규칙 적용 여부) → 메뉴 `1) 폴더별로 정리하기(되돌릴 수 있어요)`(중복 사본도 함께 옮기게 되면 "같은 내용의 사본 N개도 함께 옮겨요. 먼저 2)로 정리할 수도 있어요." 한 줄) / `2) 중복 파일을 휴지통으로 보내기(휴지통에서 다시 꺼낼 수 있어요. afo undo로는 되돌리지 않아요)` / `3) 자세히 보기`(`[정리] 파일 → 목적지`, `[그대로]`·`[확인 필요] 파일 — 이유`) / `4) 그만두기` / `5) 내 정리 방식 알려 주기` → 실행될 작업 목록(최대 20줄 + "외 N개") → **위험도에 맞춘 확인**: 정리(되돌릴 수 있음)는 "이대로 정리할까요? … (Y/n)"에 Enter·`y`, 휴지통 보내기는 "… 휴지통으로 보낼까요? … (y/N)"에 `y`를 직접 입력해야 실행(Enter는 아니요) → 결과 요약(실행 ID 없이 개수와 이유, 기록은 `afo runs`).
  - `afo <폴더>`: 명령 이름이 아니고 실제로 있는 폴더 하나를 주면 폴더 질문 없이 그 폴더로 시작합니다. 터미널이 아니면(파이프·스크립트) `preview <폴더>`와 같습니다. 폴더가 아닌 낯선 단어는 지금처럼 사용법 오류(2)입니다.
  - **지난번 폴더**: 정리나 휴지통 보내기를 실행하면 그 폴더를 상태 폴더의 `guided.json`에 기억합니다. 다음에 `afo`만 입력하면 "지난번에 정리한 폴더: …"를 보여 주고 그냥 Enter로 그 폴더를 다시 정리합니다(`q`는 종료). 기억한 폴더가 없어졌으면 묻지 않습니다.
  - **진행률**: 터미널에서는 파일이 많아 0.3초 넘게 걸리면 "폴더를 살펴보는 중이에요… 파일 1,240개", 해시 단계는 "같은 내용인지 확인하는 중이에요… 120 / 300개"를 한 줄로 고쳐 쓰며 보여 줍니다.
  - **5) 내 정리 방식 알려 주기**: 잘 정리해 둔 폴더를 끌어다 놓으면 폴더 구조와 파일 이름만 보고(내용은 읽지 않음) `suggest-rules`와 같은 규칙을 찾아 "모든 .pdf 파일 → 과제/물리/ (예: …)"처럼 보여 주고, "이 방식을 저장해서 … (Y/n)"에 `y`면 `rules save --select <모든 규칙>`과 같이 저장한 뒤 작업 폴더를 다시 분석해 요약과 메뉴를 보여 줍니다. 참고한 폴더의 파일은 옮기거나 지우지 않습니다. 근거가 부족하면 그렇게 알리고 메뉴로 돌아갑니다. 저장된 규칙이 없을 때 요약에 이 메뉴를 알려 줍니다.
  - 폴더 입력은 앞뒤 공백, 감싼 따옴표, macOS 터미널 드래그의 `\ ` 같은 백슬래시 이스케이프(Windows 제외), 앞의 `~/`(홈)를 정리합니다. 빈 입력은 종료(0), 지난번 폴더가 있으면 그 폴더. 거부된 폴더는 이유를 한 줄로 보여 주고 다시 묻고, 3번 실패하면 1입니다.
  - 할 일이 없는 메뉴는 "할 일 없음"으로 표시하고 고를 수 없습니다. 알아듣지 못한 번호가 3번 이어지면 2. 빈 입력·`4`는 그만두기(0, 아무것도 바꾸지 않음). 다시 묻는 문구는 "1~5 중에서 골라 주세요."
  - 1·2를 고르면 `plan`과 같은 함수(`createPlan`)로 계획을 다시 만들어 상태 폴더에 저장하고(1은 기본 옵션, 2는 `--delete-duplicates all`·휴지통), `y`(정리는 Enter도)라고 답하면 그 방식 작업 전체의 승인 코드로 `apply`와 같은 경로(`applyCommand`: `issueApproval` → `consumeApproval` → `executeBatch`)를 실행합니다. 사용자가 코드를 입력하지 않을 뿐 승인 발급·일회성 소비·실행 직전 재검증은 같습니다. `n`(휴지통은 Enter도)은 실행하지 않고 4, 알아듣지 못한 답 3번은 2(둘 다 승인 기록 없음, 파일 변경 없음).
  - **종류를 모르는 파일**(기본 분류표에 없는 확장자 `UNKNOWN_EXTENSION`, 확장자 없음 `NO_EXTENSION`)이 있으면 1을 고른 뒤 계획 전에 한 번 묻습니다: "종류를 모르는 파일이 있어요: .xyz 2개(예: data.xyz), 확장자 없음 1개(예: 메모)" → `1) 모두 '기타' 폴더로 옮기기` / `2) 확장자마다 폴더 정하기` / `3) 그대로 두기(기본)`(빈 입력 = 3, 알아듣지 못한 번호 3번이면 2). 정리할 다른 파일이 없어도 종류를 모르는 파일이 있으면 1을 고를 수 있습니다(메뉴에 "종류를 모르는 파일 N개(옮길 곳을 물어봐요)"). 숫자로만 된 확장자(`2024.10.30`의 `.30`, `.001`)는 날짜·분할 번호로 보고 "확장자 없음"과 함께 묻습니다(엔진 분류는 그대로 `UNKNOWN_EXTENSION`). 1은 이미 `기타/` 안에 있는 파일을 옮길 개수에서 뺍니다.
    - 2는 확장자마다(그리고 "확장자 없음"에 한 번) "'.xyz' 파일 2개를 어느 폴더로 옮길까요?"를 묻습니다. 빈 입력은 그대로 두기, 폴더 이름은 `TargetDirectorySchema`로 검사해 숨김·`..`·절대 경로·특수 문자·Windows 예약 이름(`CON`·`NUL` 등)·끝의 점이나 공백·한 단계 255바이트(UTF-8, NFC) 초과·옮긴 뒤 전체 경로 1023바이트 초과를 이유와 함께 거부하고 다시 묻습니다(3번째에는 이유와 "그대로 둘게요"를 한 줄로, 그 확장자는 그대로). 이미 그 폴더 안에 있는 파일은 옮기지 않습니다. 이어서 "다음에도 '.xyz' 파일은 '<폴더>' 폴더로 정리할까요? (y/N)"에 `y`면 저장 수정(확장자 조건, 키워드 없음)으로 저장해 이후 `preview`·`plan`·`afo`에 적용합니다(`rules list`로 보고 `rules forget <수정ID>`로 지움). 확장자 없음(숫자로만 된 확장자 포함)과 조건으로 쓸 수 없는 확장자(영문 소문자·숫자 16자 밖, 예: `.한글`)는 묻지 않고 "…기억할 수 없어 이번에만 옮겨요."로 알립니다. 저장은 계획을 만들기 전에 하므로 뒤에서 `n`으로 답하거나 Ctrl+C로 멈추면 "파일은 바꾸지 않았어요(저장한 규칙은 남아 있어요)."라고 알립니다.
    - 이번 정리에는 `--move`와 같은 일회성 수정으로 넣어 같은 계획·승인 코드·실행 경로를 탑니다. 안내형은 `<경로>=<폴더>` 문자열을 만들지 않고 파일 ID로 넘깁니다(`analyzeTarget`의 `overrides`; 이름에 `=`가 있어도 됨, 그 사이 파일이 바뀌면 `FILE_CHANGED`). 참고 폴더 보호 파일·읽기 실패 파일·확장자가 여러 개인 파일은 묻지 않습니다.
    - 옮기려던 파일(기본 분류로 옮길 파일과 방금 고른 파일)이 계획에서 빠지면 계획의 분석 이유로 알립니다: "옮기지 못하는 파일 N개(그대로 둬요):" 아래 이유별로 `e.xyz — '기타'라는 파일이 이미 있어 그 이름으로 폴더를 만들 수 없어요(이름 충돌)`, "옮길 곳에 같은 이름이 이미 있어요(이름 충돌, 덮어쓰지 않아요)", "옮길 곳에서 다른 파일과 이름이 겹쳐요(덮어쓰지 않아요)" 등(최대 3개 + "외 N개"). 남는 작업이 없으면 "옮길 수 있는 파일이 없어요."이고, "살펴보는 사이 파일이 바뀌어"는 계획의 분석에서 그 파일이 실제로 없어졌을 때만 씁니다.
    - 다운로드 중일 수 있는 파일(`.part`·`.crdownload`·`.download`, 이유 코드 `INCOMPLETE_DOWNLOAD`)은 묻지 않고 "다운로드 중일 수 있는 파일 N개(예: …)는 그대로 둬요."로만 알립니다.
    - 비대화형 명령(`preview`·`plan`)의 동작은 그대로입니다(종류를 모르는 파일은 검토 항목).
  - **영구 삭제는 메뉴에 없습니다.** `plan --delete-mode permanent` + `apply --mode permanent-delete`(확인 문구 포함)로만 합니다.
  - 질문·요약·메뉴는 stderr, 마지막 결과 요약(옮김/휴지통/건너뜀/실패 수, 옮기지 않은 파일과 이유, 이동이면 "되돌리려면: afo undo")은 stdout입니다. 종료 코드는 apply와 같습니다(0, 일부 실패 3, 취소 130).
  - 사용자가 고른 멈춤은 "AFO 오류:" 없이 한 줄입니다: 확인에 `n`(4) "정리하지 / 휴지통으로 보내지 않았어요. 아무것도 바꾸지 않았어요.", 알아듣지 못한 답 3회(2) "답을 알아듣지 못해 그만둘게요. …", 폴더 3회 실패(1), 번호 3회 실패(2). 실행 전(질문·분석·계획 중) Ctrl+C는 "그만뒀어요(Ctrl+C). 아무것도 바꾸지 않았어요."(130), 실행 중 Ctrl+C는 "정리를 중간에 멈췄어요" + 남은 파일 수·이미 옮긴 파일 수(130).
  - 안내형 화면이 다시 쓰는 서비스 문장(폴더 거부 이유, 파일별 결과 이유)은 해요체로 바꿔 보여 줍니다(`apps/cli/src/words.ts`). 상세 명령(preview/plan/apply/undo <ID>)의 출력은 그대로입니다.
  - 터미널(TTY)이 아니면(파이프·스크립트) 인수 없는 `afo`는 지금처럼 도움말만 출력합니다(0).
- `afo undo`(실행 ID 생략): 가장 최근의 되돌릴 수 있는 실행(이동이 있고 아직 되돌리지 않은 organize 실행)을 찾아 `undo <실행 ID>`와 같은 검사로 되돌립니다. 터미널에서는 "되돌릴까요? (Y/n)"에 Enter·`y`로 답하면 되고(`n`은 4, 아무것도 바꾸지 않음), 내부적으로는 같은 확인 코드(실행 ID 앞 8자)를 씁니다. 화면은 짧습니다: "10월 30일 오후 1:11에 정리한 파일 5개를 원래 자리로 되돌릴까요?"(로컬 시각) + 파일 목록(최대 20줄, `문서/보고서.pdf → 보고서.pdf`, 작업 ID 없음) + "되돌릴까요? (Y/n)"(터미널이 아니면 코드 줄), 결과는 "되돌렸어요: 5개 · 건너뜀 0"(되돌리지 않은 항목만 이유 표시)과 지운·남긴 폴더. `--json` 출력과 종료 코드는 `undo <실행 ID>`와 같습니다. 되돌릴 실행이 없으면 안내 후 0. 터미널이 아니면 `--confirm <그 실행 ID 앞 8자>`가 필요하고 없으면 4입니다.
- 중복 묶음의 기본 남길 파일(keeper)은 보호 파일 → 이름에 사본 표시가 없는 파일(확장자 앞의 ` (1)`~` (99)`, ` copy`, ` copy 2`, `_copy`, `-copy`, ` 사본`, ` 복사본`, `복사본`, ` - 복사본`, ` - 복사본 (2)` 등, 대소문자·NFC 무시) → 더 얕은 경로 → 더 짧은 이름 → 경로 순서로 정합니다(`packages/engine/src/duplicates.ts`, 같은 파일이면 항상 같은 결과). 예: `보고서.pdf`와 `보고서 (1).pdf`는 `보고서.pdf`를 남깁니다. 웹사이트(`apps/website`)의 미리보기 규칙과는 별개입니다.

## 기본 분류표(default-4)

v0.5.0의 분류표 확대·본문 추출 지원 형식, 이름 충돌·복합 규칙·OCR·사진 분석은 [추가 기능 안내](SMART_ORGANIZE.md)를 확인하세요. `afo formats`는 실제 분석 대상 형식, `afo formats --categories`는 종류별 분류 확장자를 출력합니다. 둘은 같은 지원 범위를 뜻하지 않습니다.

`packages/engine/src/defaults.ts` 하나를 CLI와 웹사이트 `/preview`가 함께 씁니다(분류표를 바꾸면 `CLASSIFICATION_VERSION`도 바꿉니다. 이전 버전으로 만든 계획은 다시 만들어야 합니다). 확장자는 대소문자를 구분하지 않고, 한 확장자는 한 분류에만 속합니다. 파일 이름만 보며 내용은 읽지 않습니다.

| 분류(목적지 폴더) | 확장자 |
| --- | --- |
| 문서 | pdf hwp hwpx hwt show cell doc docx docm txt md rtf tex odt odp ods ppt pptx pptm xls xlsx xlsm csv key keynote pages numbers one xps |
| 이미지 | png jpg jpeg jfif gif webp avif heic heif jxl svg tif tiff bmp ico raw cr2 cr3 nef arw dng orf rw2 |
| 영상 | mp4 m4v mov mkv avi webm wmv flv 3gp mpg mpeg vob mts m2ts, 자막 srt smi ass vtt |
| 음악 | mp3 wav flac m4a ogg aac wma aiff aif opus mid midi amr alac ape |
| 압축 | zip 7z rar tar gz tgz bz2 xz zst lz lzma cab alz egg tbz txz. 바깥 확장자가 순수 압축 형식(gz bz2 xz zst lz lzma 7z zip rar)이면 안쪽 확장자와 상관없이 압축(`dump.sql.gz`, `table.csv.bz2`, `photos.jpg.zip`, `.tar.gz`·`.tar.xz` 등) |
| 설치 | dmg pkg exe msi apk xapk deb rpm appimage iso msix appx |
| 디자인 | psd ai sketch fig xd indd afdesign afphoto procreate blend obj fbx stl |
| 글꼴 | ttf otf ttc woff woff2 |
| 전자책 | epub mobi azw azw3 |
| 코드 | py ipynb js mjs jsx tsx java c h cpp hpp cs swift kt go rs rb php html htm css scss sh bat ps1 r |
| 데이터 | json xml yaml yml toml sql db sqlite sqlite3 parquet tsv log |

- 일부러 넣지 않은 확장자(계속 "확인 필요"): `ts`(TypeScript·MPEG-TS 영상), `m`(Objective-C·MATLAB), `bin`, `dat`, `tmp`, `lnk`, `url`, `webloc`, `alias`.
- `.part`·`.crdownload`·`.download`는 다운로드가 끝나지 않았을 수 있어 옮기지 않습니다(`INCOMPLETE_DOWNLOAD`, `movie.mp4.part`처럼 안쪽 확장자가 알려져 있어도). 참고 폴더에서 배운 개인 규칙도 적용하지 않고, 사용자가 명시한 `--move`·저장 수정만 적용합니다.
- 바깥 확장자가 순수 압축 형식이 아닌데 안쪽에 알려진 확장자가 있으면(`report.pdf.exe`, `invoice.pdf.scr`, `photo.jpg.exe`, `a.tar.tgz`) 바깥 확장자를 알든 모르든 위장일 수 있어 확인 필요(`COMPOUND_EXTENSION`)입니다.

이 문서는 `apps/cli/src/`에 **구현된** 동작만 적습니다.
정리 대상 파일을 옮기거나 지우는 명령은 `apply`와 `undo`뿐입니다(인수 없는 대화형 `afo`도 내부적으로 같은 `applyCommand`를 부릅니다). 둘 다 확인 코드를 직접 입력해야 하고, 실제 정리 작업은 공용 실행 서비스(`packages/filesystem/src/approvals.ts`·`executor.ts`)만 합니다. `update`는 설치된 AFO 실행 파일을 교체합니다.

## 업데이트

`afo update`(추가 인수·옵션 없음)는 단일 실행 파일 설치본용입니다. GitHub Releases의 최신 정식 버전과 숫자 순서로 비교해 새 버전이 있을 때만 내 OS·CPU용 압축 파일을 받습니다. `SHA256SUMS`와 SHA-256 대조 → 임시 폴더에 실행 파일만 추출 → `--version` 결과 대조 → 설치 파일 교체 순서로 진행합니다. 네트워크·검증 실패는 오류(1), 사용법 오류는 2, Ctrl+C 취소는 130입니다. 이미 최신이거나 더 새 버전이면 설치본을 보존하고 성공(0)으로 끝납니다. API 인증은 필요 없으며 GitHub가 요청 한도를 거부하면 자동 재시도하지 않습니다.

macOS의 PATH 심볼릭 링크는 실제 설치 파일로 해석해 링크를 보존합니다. Windows는 실행 중인 이전 파일을 다른 이름으로 옮긴 뒤 새 파일을 놓고, 교체 실패 시 원래 이름으로 복원합니다. 이전 파일이 실행 중이라 삭제되지 않으면 백업 경로를 안내합니다. 개인 규칙·계획·실행 기록, PATH, Finder/탐색기 메뉴는 변경하지 않습니다. 실행 중인 다른 AFO 세션은 종료 후 다시 시작해야 새 버전을 사용합니다.

소스 실행본에서는 Node.js 자체를 교체하지 않고 오류와 업데이트 안내를 출력합니다. 저장소에서 `git pull`, `npm ci --ignore-scripts`, `npm run build`를 사용합니다. `update`는 v0.4.0부터 제공되므로 이 명령이 없는 기존 설치본은 설치 스크립트를 한 번 다시 실행해야 합니다.

검증 시에만 `AFO_UPDATE_BASE=http://127.0.0.1:<포트>`로 `latest.json`·압축 파일·`SHA256SUMS`를 제공할 수 있습니다. 외부 HTTP 주소는 거부합니다. 중단된 업데이트의 `<실행 파일>.update-lock`이 남으면 실행 중인 업데이트가 없는지 먼저 확인해야 합니다. 잠금을 자동 제거하거나 실패한 업데이트를 재실행하지 않습니다.

## 명령

먼저 `npm run build`가 필요합니다. 설치·검사 방법은 [DEVELOPMENT.md](DEVELOPMENT.md)를 봅니다. 아래 `...`은 `node dist/apps/cli/src/index.js`입니다.

| 명령 | 하는 일 | 쓰는 곳 |
| --- | --- | --- |
| `... help` (`--help`·`-h`도 같음, 터미널이 아닐 때 인수 없음도 같음) | 자주 쓰는 명령과 안전 안내만 보여 주는 짧은 도움말 | 없음 |
| `... help --all` | 모든 세부 명령·옵션·안전 규칙·종료 코드 | 없음 |
| `afo` (인수 없음, 터미널) | 위 "빠른 시작"의 안내형 정리. 내부적으로 plan과 apply의 같은 함수를 씀 | 작업 폴더(코드를 입력한 이동·휴지통), 상태 폴더 |
| `... preview <폴더> [옵션]` | 스캔·분류·중복 후보·미리보기 출력. **저장된 개인 규칙을 자동 적용** | 없음(`--remember`일 때만 상태 폴더) |
| `... plan <폴더> [옵션]` | preview와 같은 분석 → 정리 계획(작업 ID·종류·원본→목적지·이유, 삭제는 남길 파일과 논리 크기) → 상태 폴더에 저장 → 방식별 승인 코드 출력. 승인을 발급하거나 파일을 바꾸지 않음 | 상태 폴더(`plans/`) |
| `... suggest-rules <참고 폴더> [--json]` | 참고 폴더의 이름·확장자만 읽어 규칙 후보(draft) JSON을 stdout에, 한국어 요약을 stderr에 출력. `--json`이면 요약 생략 | 없음(초안 파일 저장은 사용자의 셸 리디렉션) |
| `... rules save <초안 JSON> --select <ID,...>` | 고른 규칙만 확인(confirmed)해 앱 로컬 프로필로 저장. 빈 선택·모르는 ID 거부. 기존 프로필의 규칙은 대체하고 **저장한 수정은 유지** | 상태 폴더 |
| `... rules list [--json]` | 저장 프로필: ID·revision·켜짐/꺼짐·참고 폴더 이름, 규칙별 근거 예시·목적지·켜짐 여부, 저장한 수정. 없음·손상도 안내(종료 코드 0) | 없음 |
| `... rules enable\|disable <규칙ID>` | 저장 규칙 하나를 켜기/끄기 | 상태 폴더 |
| `... rules enable-all\|disable-all` | 프로필 전체 켜기/끄기. 꺼진 동안 기본 분류, 참고 파일 보호는 유지 | 상태 폴더 |
| `... rules forget <수정ID>` | `--remember`로 저장한 수정 하나 지우기 | 상태 폴더 |
| `... rules reset [--confirm reset]` | 저장 규칙·수정을 모두 잊기. TTY면 `[y/N]` 질문, 비TTY면 `--confirm reset` 필수 | 상태 폴더 |
| `... confirm-rules <규칙 JSON> --select <ID,ID>` | (이전 방식) 고른 규칙만 `confirmed`로 바꾼 JSON 출력. 저장하지 않음 | 없음 |
| `... apply <계획 ID> --mode organize\|trash\|permanent-delete [옵션]` | 저장된 계획의 한 방식 작업을 보여 주고 승인 코드(영구 삭제는 문구도)를 확인한 뒤 `issueApproval` → `consumeApproval` → `executeBatch`로 **실제 실행** | 작업 폴더(이동·휴지통·영구 삭제), 상태 폴더(`approvals/`·`runs/`·`journal/`·`locks/`) |
| `... undo <실행 ID> [--confirm <코드>] [--json]` | 이동(organize) 실행만 원래 위치로 되돌림(`undoRun`). 확인 코드는 실행 ID 앞 8자 | 작업 폴더(역이동), 상태 폴더 |
| `... runs [<실행 ID>] [--json]` | 실행 기록 요약(시각·방식·결과 수·되돌리기 횟수·undo 가능 여부) 또는 한 실행의 항목별 결과와 되돌리기 기록 | 없음 |
| `... recover [--json]` | `inspectRuns`로 끝나지 않은 실행·결과 불명 항목과 해제 조건을 보고. 자동 재실행·원복·삭제 없음 | 없음 |
| `... gui [<폴더>] [--port <번호>] [--no-open] [--exit-when-closed]` | 이 컴퓨터에서만 열리는 브라우저 화면(아래 "화면으로 보기")으로 미리보기·계획·규칙·실행 기록·복구 점검을 보고, 화면에서 목록을 확인한 뒤 정리(organize)·휴지통(trash)·되돌리기를 `apply`·`undo`와 같은 경로로 실행. 영구 삭제는 하지 않음 | 상태 폴더(`plans/`, 실행하면 `approvals/`·`runs/`·`journal/`·`locks/`), 화면에서 실행·되돌리기를 누르면 작업 폴더 |

`preview` 옵션:

| 옵션 | 뜻 |
| --- | --- |
| `--reference <참고 폴더>` | 참고 폴더를 읽어 그 안의 기존 파일을 보호하고 규칙 후보를 함께 보여 줌(저장·적용하지 않음) |
| `--profile <JSON>` | 저장 프로필 대신 v1/v2 프로필 파일을 적용 |
| `--no-saved-rules` | 저장 프로필을 쓰지 않고 기본 분류 |
| `--move <상대 경로>=<목적지 폴더>` | 이번 미리보기에만 적용하는 사용자 수정(여러 번 가능). 목적지는 작업 폴더 기준 상대 폴더(숨김·`..`·절대 경로 불가, 한 단계 255바이트 이하) |
| `--remember` | `--move`의 수정을 파일 이름 조건으로 "이후에도 적용" 저장하고 그 사실과 수정 ID를 출력. 미리보기가 성공한 뒤에만 저장 |
| `--json` | stdout에 JSON만: `{ preview, suggestedProfile, profile: { source, id, revision, status, warning? }, remembered? }` |

- 저장 프로필이 손상됐으면 `preview`는 stderr에 경고를 내고 기본 분류로 계속합니다(종료 코드 0, JSON `profile.source: "corrupt"`). 규칙 편집과 `--remember`는 거부합니다. `rules reset`·`rules save`는 손상 파일을 지우지 않고 `corrupt-*.json`으로 옮긴 뒤 진행합니다.
- 상태 폴더는 `AFO_STATE_DIR`(절대 경로)를 따르고, 없으면 OS 앱 데이터 폴더입니다. `--remember`는 상태 폴더가 작업·참고 폴더와 겹치면 거부합니다(`STATE_DIR_CONFLICT`).
- 저장한 참고 폴더의 이름·위치가 바뀌었거나 근거 파일이 다른 폴더에서 발견되면(`preview.profileNotice.code: "PROFILE_STALE"`) 저장 프로필을 이번 분석에 적용하지 않습니다. 사람용 출력은 `개인 규칙: 저장된 프로필(revision N) — 이번 분석에는 적용하지 않음(참고 폴더 변경 감지, …)`과 `경고:` 한 줄, JSON은 `profile.source: "stale"`(`id`·`revision`은 저장된 프로필의 값, `preview.profileId`는 `null`)입니다. 저장소에는 쓰지 않습니다.
- 변경 명령은 읽은 상태를 고정해 넘깁니다: 활성 프로필은 `expectedRevision: <revision>`, 빈 저장소는 `expectedRevision: null`, 손상 파일은 `expectedCorrupt: <fingerprint>`. 그 사이 다른 프로세스가 바꿨으면 `PROFILE_CHANGED`로 거부합니다. 검사와 쓰기는 상태 폴더 `locks/`의 프로필 잠금 안에서 함께 실행되며, 다른 실행이 잠금을 가진 동안 약 3초 기다린 뒤에도 풀리지 않으면 `LOCKED_BY_OTHER`(종료 코드 1)입니다.
- 사람용 출력은 참고 폴더를 마지막 이름(라벨)으로만 표시합니다. 단, `suggest-rules`의 초안 JSON과 `preview --json`의 `suggestedProfile`·`preview.root`는 계약(v1 `ProfileSchema`, `PreviewSchema`)상 실제 절대 경로를 담습니다. `rules save`로 저장한 프로필에는 절대 경로가 남지 않습니다.

`plan` 옵션: `--reference`·`--profile`·`--no-saved-rules`·`--move`는 preview와 같습니다(`--move`는 이번 계획에만 적용, `--remember`는 쓸 수 없음).

| 옵션 | 뜻 |
| --- | --- |
| `--delete-mode trash\|permanent` | 삭제 작업의 방식. 기본 `trash`(OS 휴지통). `permanent`는 **되돌릴 수 없음**을 출력하고, 실행 때 승인 코드와 확인 문구 `영구 삭제`가 모두 필요하다고 안내 |
| `--delete-duplicates all\|<해시,...>` | 중복 후보를 삭제 작업에 넣음. 각 그룹의 남길 파일(keeper)은 작업에 넣지 않고 유지 항목으로 남김. 해시는 출력의 그룹 해시 앞 8자 이상(모호하면 `KEEPER_INVALID`) |
| `--delete-file <상대 경로>` | 직접 고른 파일 하나를 삭제 작업에 넣음(여러 번 가능, keeper 없음). 참고한 기존 파일은 거부(`ROOT_FORBIDDEN`). 내용이 같은 파일(해시가 같은 2개 이상)을 **모두** 고르면 "모든 사본이 삭제됩니다" 오류(`KEEPER_INVALID`, 종료 코드 1)로 거부하고 아무것도 저장하지 않음 |
| `--delete-last-copy` | 위의 경우에도 마지막 사본까지 지우는 것을 명시적으로 허용. `--delete-file` 없이 쓰면 사용법 오류(2). 그 작업의 이유에 마지막 사본 삭제임을 적고, 사람용 출력에 경고 줄을 냄. 중복이 아니거나 사본이 하나 남는 삭제에는 필요 없음 |
| `--json` | stdout에 JSON만: `{ planId, plan, approvalChoices, reviewItems }`. `plan`은 `OperationPlanSchema`, `approvalChoices`는 방식별 `{ mode, operationIds, code }` |

- 사람용 출력: 계획 ID, 만료 시각(생성 후 1시간), 개인 규칙 적용 상태, 삭제 방식, 방식별 작업 목록, 중복 후보 그룹(해시 앞 12자), 검토·유지 항목의 이유별 개수와 예시, 방식별 승인 코드, `apply <계획 ID> --mode <방식>` 실행 안내. 크기는 논리 크기이며 확보량이 아닙니다.
- 승인 코드는 그 방식의 작업 **전체**를 묶은 코드입니다(`approvalChoices`). 이 명령은 승인 기록을 만들지 않습니다(승인은 `apply`가 발급·소비).
- 같은 폴더를 다시 plan하면 상태 폴더의 `plans/latest-<루트ID>.json`(CLI가 쓰는 작은 인덱스, 계획 ID만 저장)으로 직전 계획을 찾아 `diffPlans`로 비교하고, **새로 추가·바뀐 작업과 빠진 작업만** 표시합니다. 작업 ID는 파일 식별·크기·수정 시각·목적지·keeper의 해시라 같은 ID는 이미 본 작업입니다. 프로필·삭제 방식 변경과 같은 경로의 폴더 교체도 알립니다. `--json`은 항상 전체 계획입니다. 직전 계획을 읽지 못하면 stderr에 알리고 전체를 표시합니다.
- 계획 ID는 생성 시각·세션·폴더 권한을 포함하므로 같은 입력이어도 실행마다 다릅니다. 파일이 같으면 작업 ID 집합은 같습니다.
- 계획은 저장된 개인 규칙의 ID·revision에 묶입니다. 저장 프로필과 다른 `--profile` 파일의 규칙이 적용된 계획은 저장하지 않습니다(`PROFILE_CHANGED`, 종료 코드 1). 그 규칙을 쓰려면 `rules save`로 저장한 뒤 plan 합니다.
- 상태 폴더가 작업·참고 폴더와 겹치면 아무것도 쓰기 전에 거부합니다(`STATE_DIR_CONFLICT`).
- plan은 분석(`analyzeRoot`)이 미리보기를 만든 바로 그 스캔(중복 해시 포함, `Analysis.scan`)으로 계획을 만듭니다. 두 번째 스캔·해시가 없어 분석과 계획 사이의 파일 변경 경쟁 창이 없습니다. 분석 이후의 파일 변경은 계획에 반영되지 않으며, apply의 실행 직전 재검증(executor)에서 해당 항목을 거부합니다.
- 영구 삭제 확인 문구는 실행(승인) 때 NFC 정규화 후 `영구 삭제`와 비교합니다(조합형 NFD 입력도 같은 문구로 인정). 승인의 결합 대상과 위협 모델은 [ADR 0003](adr/0003-approval-binding.md)을 봅니다.

## 실행: apply

`apply <계획 ID> --mode organize|trash|permanent-delete [--only <작업ID,...>] [--confirm <승인 코드>] [--phrase <확인 문구>] [--json]`

| 옵션 | 뜻 |
| --- | --- |
| `--mode` (필수) | 한 번에 한 방식만: `organize`(이동 작업), `trash`(휴지통 작업), `permanent-delete`(영구 삭제 작업). 계획에 그 방식의 작업이 없으면 `MODE_MISMATCH`(4) |
| `--only <작업ID,...>` | 그 방식 작업 중 일부만. 다른 종류·모르는·중복 ID는 거부(4). 부분 선택의 승인 코드는 plan의 코드와 다르며 apply의 확인 요약(stderr)에 표시됩니다 |
| `--confirm <승인 코드>` | 확인 요약에 나온 8자 코드. **TTY가 아니면 필수**이고 없으면 종료 코드 4로 거부하며 승인을 발급하지 않습니다. TTY면 생략 시 입력을 받습니다(빈 입력은 거부 4) |
| `--phrase <확인 문구>` | `permanent-delete`에서만(다른 방식에 쓰면 2). 정확히 `영구 삭제`(NFC 비교). TTY가 아니면 필수, TTY면 생략 시 입력을 받습니다 |
| `--json` | stdout에 JSON만: `{ runId, report }`(`report`는 `ExecutionReportSchema`). 확인 요약은 입력·옵션이 필요할 때만 stderr에 출력 |

- 순서: `loadSavedPlan`으로 저장 계획을 읽고 → 선택 작업·이유·남길 파일(keeper)·논리 크기("확보량 아님")·영구 삭제면 "되돌릴 수 없음"과 승인 코드를 stderr에 표시 → 코드(와 문구) 확인 → `issueApproval` → `consumeApproval` → `executeBatch`(루트 잠금 안에서 작업마다 저널 선기록·실행 직전 재검증·독립 확인).
- 승인 코드는 `approvalCode(계획 ID, 정렬된 작업 ID, 방식)`입니다. 틀린 코드·다른 방식의 코드·만료된 계획은 서비스가 거부합니다(4, 파일·승인 기록 변경 없음). 계획 뒤 개인 규칙이 바뀌면 `PROFILE_CHANGED`(1), 계약에 맞지 않게 손상·변조된 계획 파일은 `STATE_CORRUPT`(1)로 거부하며 역시 아무것도 바꾸지 않습니다. 계약에는 맞지만 내용 해시가 맞지 않는 계획은 `PLAN_CHANGED`(4)입니다. `--yes` 같은 불리언 동의 옵션은 없습니다(2).
- **같은 작업은 이 CLI로 두 번 실행하지 않습니다.** 같은 계획의 실행 기록(`runs/`)에 고른 작업 ID가 하나라도 있으면 새 승인을 발급하지 않고 `APPROVAL_USED`(4)로 거부합니다. 실행 기록을 읽을 수 없으면 실행하지 않습니다(`STATE_CORRUPT`, 1). 다시 정리하려면 plan부터 다시 합니다. 한 승인 기록의 재사용은 서비스(`approvals/<id>.used`, `runs/<id>.approval`)가 막습니다.
- 사람용 결과(stdout): 실행 ID, 항목별 결과(`이동함`/`휴지통으로 보냄`/`영구 삭제함`/`건너뜀`/`실패`/`결과 불명`과 오류 코드·이유), 개수, 논리 크기 합계(확보량 아님), 영구 삭제만 관측한 여유 공간 전후(다른 프로그램 영향 가능), 서비스의 공간 설명, 되돌리기 안내(이동만 `undo <실행 ID>`, 휴지통은 OS 휴지통에서 사용자가 복원, 영구 삭제는 되돌릴 수 없음).
- 실행 직전 재검증: plan 이후 바뀐 원본은 `FILE_CHANGED`/`SOURCE_MISSING`으로 실패, 목적지에 이미 파일이 있으면 `DEST_EXISTS`로 실패(덮어쓰지 않음), 다른 항목은 계속 처리합니다(종료 코드 3).
- 다른 실행이 같은 작업 폴더의 잠금을 갖고 있으면 `LOCKED_BY_OTHER`(1). 파일·실행 기록은 바뀌지 않지만 이번 승인은 이미 소비됐으므로, 다른 실행이 끝난 뒤 apply를 다시 실행해 승인을 다시 받아야 합니다. 잠금은 상태 폴더 안에 있어 `AFO_STATE_DIR`가 다른 두 실행은 서로 막지 못합니다(#10 R2-1).
- 실행은 끝났지만 잠금을 풀지 못한 경우(메시지 "작업은 끝났지만", 1)와 결과 파일을 저장하지 못한 경우(1, 결과는 출력하고 저널에 남음)는 같은 apply를 다시 실행하지 말고 `runs <실행 ID>`·`recover`로 확인하라고 안내합니다.

## 되돌리기·기록·복구

- `undo [<실행 ID>] [--confirm <실행 ID 앞 8자>] [--json]`: 실행 ID를 빼면 `runSummaries`로 가장 최근의 되돌릴 수 있는 실행을 고른 뒤 같은 절차입니다(없으면 0, JSON `{ runId: null, report: null, message }`). `readRun`으로 되돌릴 후보(이동했고 아직 되돌리지 않은 항목, 정리한 위치 → 원래 위치)를 stderr에 보여 주고 확인 코드를 TTY 입력 또는 `--confirm`으로 받습니다(비TTY에서 없거나 틀리면 4). 그 뒤 원래 폴더 권한을 다시 발급해 `undoRun`을 호출합니다. 원래 경로가 차 있거나(`DEST_EXISTS`) 정리한 파일이 바뀐(`FILE_CHANGED`) 항목은 `되돌리지 않음`으로 표시하고 덮어쓰지 않습니다(종료 코드 3). 결과가 확인되지 않은 항목은 추측해 옮기지 않고 `결과 불명`으로 보고합니다. 휴지통·영구 삭제 실행은 되돌리지 않습니다(1, 휴지통은 OS에서 사용자가 복원). 되돌릴 항목이 없으면 확인 없이 0. 그 실행이 **새로 만든** 폴더(실행 기록 `runs/<실행 ID>.json`의 `createdDirectories`: 경로와 dev/ino)는 되돌린 뒤 깊은 것부터 하나씩 `rmdir`합니다. 같은 폴더(dev/ino·링크 아님, 부모 경계 검사)이고 비어 있을 때만 지우며 재귀 삭제는 없습니다. 원래 있던 폴더는 목록에 없어 지우지 않고, 사용자가 파일을 넣었거나 바뀐 폴더·지우지 못한 폴더는 그대로 두고 결과(`report.directories.kept`, 사람용 출력)에 이유를 표시합니다. 이 목록이 없는 이전 실행 기록은 지금처럼 되돌리고 폴더는 지우지 않습니다. `--json`: `{ runId, report }`(`report.directories: { removed, kept }`는 목록이 있는 실행에만).
- `runs [--json]`: `listRuns`/`readRun`의 요약을 시작 시각 순으로. JSON `{ runs: [{ runId, planId, mode, startedAt, finishedAt, results, undos, undone, undoable }] }`(`results`는 상태별 개수, 끝나지 않은 실행은 `null`; 읽을 수 없는 기록은 `{ runId, error }`). `runs <실행 ID> [--json]`: 항목별 결과·공간 설명·되돌리기 회차별 결과, JSON은 `{ run, undos }`. 없는 실행 ID는 1, 형식이 아니면 2.
- `recover [--json]`: `inspectRuns(상태 폴더, { loadPlan: loadSavedPlan })`. `clean`이 아닌 실행만 보고합니다(상태 `active`/`unfinished`/`corrupt`/`unreadable`, 문제, 끝나지 않은 작업의 관측 상태와 해제 조건·할 일). JSON `{ checked, runs }`. 확인이 필요한 실행이 있으면 3, 없거나 진행 중(`active`)뿐이면 0. 파일·상태 폴더를 바꾸지 않습니다.

## 화면으로 보기 (gui)

`gui [<폴더>] [--port <번호>] [--no-open] [--exit-when-closed]`(`npm run gui -- <폴더>`와 같음, 구현: `apps/cli/src/gui.ts`·`gui-assets.ts`)

- `127.0.0.1`의 빈 포트(또는 `--port`, 1024–65535)에 작은 HTTP 서버를 띄우고 stderr에 `AFO GUI: http://127.0.0.1:<포트>/#token=<무작위 48자>`를 출력한 뒤 기본 브라우저로 엽니다(`--no-open`이면 열지 않음). Ctrl+C로 끝내면 종료 코드 0입니다. 끝날 때 stdout에 화면에서 실행·되돌리기를 몇 번 했는지 적습니다.
- 폴더를 주면 화면이 열리자마자 그 폴더를 분석합니다. 화면의 폴더 입력은 절대 경로만 받습니다. 홈·디스크 루트 같은 거부 대상은 CLI와 같은 오류로 표시합니다.
- 화면: **미리보기**(개수 요약, 목적지 폴더별 묶음, 파일별 제안 검색·거르기, 중복 후보, 제외·오류), **정리 계획**(삭제 방식·중복 포함 선택 → 계획 저장 → 방식별 작업 목록과 실행 버튼), **개인 규칙**(저장 프로필·규칙·저장한 수정, 읽기만), **실행 기록**(실행별 결과와 파일 이름, 되돌릴 수 있는 이동 실행에 [되돌리기]), **복구 점검**(`recover`와 같은 보고).
- 공용 함수를 그대로 씁니다: 미리보기는 `analyzeTarget`, 계획은 `createPlan`(CLI `plan`과 같은 함수, 같은 `plans/latest-<루트ID>.json` 인덱스 갱신), 실행은 `applyCommand`, 되돌리기는 `undoCommand`, 기록은 `runSummaries`·`readRun`, 복구는 `recoverReport`(`inspectRuns`), 규칙은 `loadProfile`. CLI 출력을 파싱하지 않습니다.
- **화면에서 실행하기**: 계획을 만들면 방식별로 [정리하기](organize)·[중복 사본 휴지통으로 보내기](trash) 버튼이 나옵니다. 누르면 먼저 화면 안의 확인 상자가 작업 개수와 처음 20개 파일(정리는 `원래 위치 → 옮길 위치`, 휴지통은 남길 파일과 함께)을 보여 줍니다. 정리는 "되돌릴 수 있어요(되돌리기 버튼)", 휴지통은 "휴지통에서 직접 꺼낼 수 있어요, 되돌리기 버튼으로는 안 돼요"라고 알리고, 휴지통은 [확인했어요] 체크를 해야 실행 버튼이 켜집니다. 결과는 옮김/휴지통으로 보냄·건너뜀·실패·결과 불명 개수와 성공하지 않은 파일별 이유로 보여 줍니다. 요청 중에는 버튼을 끄고, 서버도 한 번에 한 작업만 받습니다(진행 중이면 409).
- `POST /api/apply { planId, mode: "organize" | "trash" }`는 `applyCommand(planId, { mode, confirm: <코드> }, { json: true, … })`를 그대로 호출합니다(`issueApproval` → `consumeApproval` → `executeBatch`). 코드는 서버가 저장된 계획에서 그 방식의 전체 작업으로 계산한 값(`plan`이 출력하는 승인 코드와 같음)이며 화면은 코드를 입력받지 않습니다. 화면 안의 확인 클릭이 사용자 확인입니다. 같은 계획·방식을 다시 보내면 CLI와 같이 `APPROVAL_USED`(422)로 거부합니다. `mode: "permanent-delete"`는 400으로 거부합니다: 영구 삭제는 터미널의 `apply`에서 승인 코드와 확인 문구를 직접 입력해야 합니다(화면은 그 명령만 보여 줌). 응답은 `{ exitCode, runId, report }`(`exitCode`는 CLI 종료 코드: 0·3·130).
- `POST /api/undo { runId }`는 `undoCommand(runId, { confirm: <실행 ID 앞 8자> }, { json: true, … })`입니다. 화면은 되돌릴 후보(이동했고 아직 되돌리지 않은 항목) 개수와 처음 20개를 보여 주고 확인을 받습니다. 휴지통·영구 삭제 실행은 `undoCommand`가 거부합니다(400). 응답은 `{ exitCode, runId, report }`(되돌릴 항목이 없으면 `report: null, message`).
- 파일 작업은 브라우저 탭을 닫거나 요청을 끊어도 취소하지 않습니다(절반만 하다 멈추지 않게). GUI를 Ctrl+C로 끝내면 CLI의 Ctrl+C처럼 취소합니다. 분석·계획은 요청이 끊기면 취소합니다.
- 오류는 공통 형식 `{ error: { code, message } }`입니다: 형식 오류·사용법 400, 토큰·Host·Origin 403, JSON 아님 415, AFO 오류(승인 재사용·계획 없음·만료 등) 422.
- 화면 아래의 "터미널로 하려면"을 펼치면 같은 작업의 `apply`·`undo` 명령과 코드를 보여 줍니다(단일 실행 파일이면 그 실행 파일 경로, 아니면 `node <진입 파일>`).
- `--exit-when-closed`(Finder 빠른 동작·Windows 보내기 메뉴가 씀): 페이지는 10초마다 `POST /api/ping`(토큰 필요, 본문 `{}`)을 보내고 `GET /api/presence` 요청을 열어 둡니다(백그라운드 탭의 타이머 지연에도 끊기지 않게). 열린 presence 요청이 없고 마지막 요청 뒤 60초가 지나면(처음 페이지가 120초 안에 열리지 않으면 그때) 서버를 닫고 종료 코드 0으로 끝냅니다. 실행·되돌리기 중에는 끝내지 않습니다. 테스트에서만 `AFO_GUI_FIRST_LOAD_MS`·`AFO_GUI_IDLE_MS`로 두 시간을 줄입니다.
- 요청 검사: API는 매 요청의 `x-afo-token`(시작할 때 만든 무작위 값, 상수 시간 비교), `Host`가 `127.0.0.1:<포트>` 또는 `localhost:<포트>`인지, `Origin`이 있으면 같은 주소인지 확인하고 아니면 403입니다. 페이지 자체도 `Host`를 확인합니다(DNS rebinding 방지). POST는 `application/json`·64 KiB 이하·정해진 필드만 받습니다(모르는 필드 400). 토큰은 URL의 `#` 뒤에 있어 서버 로그·Referer로 가지 않습니다.
- 페이지는 strict CSP(`default-src 'none'; script-src 'self'` 등)로 제공하고, 파일 이름은 모두 `textContent`로 넣습니다(폴더 안 이름은 신뢰하지 않는 입력).
- 한계: 같은 컴퓨터의 다른 사용자·프로세스가 토큰을 알면 이 화면과 같은 일(정리·휴지통 보내기·되돌리기 포함, 영구 삭제 제외)을 할 수 있습니다. 토큰은 이 프로세스의 stderr와 브라우저 주소에만 있습니다. `--only`(일부 작업만 승인)는 화면에 없고 방식 전체를 실행합니다. 표는 항목을 최대 500개까지 표시하고 나머지는 검색으로 좁힙니다. Windows 실물에서는 아직 확인하지 않았습니다.

검증: `tests/gui.test.ts`가 실제 `gui` 자식 프로세스(`--no-open`, temp `AFO_STATE_DIR`)로 CSP·정적 경로, 토큰 없음·틀림·다른 Host·다른 Origin·JSON 아님·상대 경로·모르는 필드 거부, 미리보기 결과가 `preview --json`과 같고 작업·상태 폴더가 바뀌지 않음, 계획 저장 내용·승인 코드 일치, GUI 계획 → CLI apply 뒤 실행 기록·파일 이름·recover 표시, **API로 정리**(독립 manifest로 목적지 sha256·원래 경로 부재·다른 파일 그대로) → 같은 apply 재시도 거부(422, 변경 없음) → **API로 되돌리기**(manifest가 처음과 같음), `permanent-delete`·토큰 없음·틀림·다른 Origin·모르는 필드·필드 누락·JSON 아님 거부(작업 폴더·실행 기록·승인 기록 변화 없음), `AFO_REAL_TRASH_TEST=1`에서만 API로 `afo-test-` 합성 사본 1개를 실제 휴지통으로(남길 파일 그대로, 그 실행의 undo 거부), `--exit-when-closed`(페이지 없음 → 0으로 종료, ping·presence 동안 유지, 끊긴 뒤 종료, 옵션이 없으면 유지), Ctrl+C 종료 코드 0(Windows 제외), 사용법 오류 2를 확인합니다. 클릭 흐름은 [검증 기록](verification/ISSUE_9_GUI.md)에 있습니다.

## 안전 규칙

- 확인 없이 실행하는 경로가 없습니다. 비TTY 실행은 `--confirm`(영구 삭제는 `--phrase`도)이 없으면 거부하고 아무것도 바꾸지 않습니다. 코드는 계획 ID·작업 목록·방식에 묶여 다른 선택·방식에 쓸 수 없습니다.
- CLI는 승인 기록을 만들거나 파일을 직접 바꾸지 않습니다. 승인 발급·소비·실행·되돌리기는 공용 서비스 함수만 호출하며, 그 서비스가 루트 경계·링크·덮어쓰기 금지·실행 직전 재검증·저널 선기록·루트 잠금을 강제합니다.
- 휴지통 실패를 영구 삭제로 우회하지 않습니다. 휴지통 비우기 명령은 없습니다. 실패·결과 불명 항목을 자동으로 다시 실행·원복·삭제하지 않습니다.

`npm run preview -- <폴더>`, `npm run rules:suggest -- <폴더>`, `npm run rules:confirm -- <JSON> --select <ID>`, `npm run afo -- rules list`도 같은 명령입니다.
JSON을 파일로 받을 때는 npm 배너가 섞이지 않도록 `node dist/apps/cli/src/index.js ...`를 직접 실행합니다.

## 종료 코드

| 코드 | 의미 | 예 |
| --- | --- | --- |
| 0 | 성공. 결과를 stdout에 출력 | `help`, 정상 `preview`. **스캔이 일부 미완료여도 0**이며 출력의 "스캔 일부 미완료"와 JSON `scanComplete: false`로 구분합니다 |
| 1 | 입력 거부 또는 오류 | 실행 잠금 `LOCKED_BY_OTHER`(apply·undo), 잠금 해제·결과 저장 실패, 없는 실행 ID, 휴지통·영구 삭제 실행의 undo, 없는 폴더, 홈·디스크 루트 같은 거부 대상, 손상된 규칙 JSON, 모르는 규칙/수정 ID, 손상 프로필 편집, `PROFILE_CHANGED`, plan의 모르는 중복 그룹·keeper 오류·`--delete-last-copy` 없이 모든 사본 선택(`KEEPER_INVALID`)·없는 파일(`SOURCE_MISSING`)·참고 파일 삭제(`ROOT_FORBIDDEN`)·`STATE_DIR_CONFLICT`, 프로필 잠금 대기 초과 `LOCKED_BY_OTHER` |
| 2 | 사용법 오류. 아무것도 바꾸지 않음 | 모르는 명령·옵션(`--execute`·`--yes` 등), apply의 `--mode` 없음·잘못된 값, 64자가 아닌 계획 ID, 실행 ID 형식 아님, organize/trash에 `--phrase`, 명령에 맞지 않는 옵션, 인수 개수, `--select` 없음·빈 선택, `--move` 형식, 비TTY `rules reset`에 `--confirm` 없음, plan의 `--delete-mode` 값·`--delete-duplicates` 형식·`--remember`·`--delete-file` 없는 `--delete-last-copy` |
| 3 | 일부 실패·결과 불명 | apply·undo에서 하나라도 `moved/trashed/deleted`(undo는 되돌림)가 아닌 항목, recover에서 확인이 필요한 실행. 결과는 stdout에 출력 |
| 4 | 확인(승인) 거부·무효. 아무것도 바꾸지 않음 | 비TTY apply·undo에 `--confirm` 없음, 영구 삭제에 `--phrase` 없음·불일치, 틀린 코드·다른 방식의 코드, 이미 실행한 작업(`APPROVAL_USED`), 만료(`APPROVAL_EXPIRED`), 없는 계획·바뀐 계획(`PLAN_CHANGED`), `MODE_MISMATCH`, TTY 빈 입력, TTY `rules reset` 질문에 y가 아닌 답, `--confirm` 값 불일치 |
| 130 | Ctrl+C(SIGINT)로 취소 | 큰 폴더 스캔 중 중단, 확인 질문 중 중단, apply·undo 실행 중 중단(남은 항목은 `CANCELLED`로 건너뜀, 결과 출력) |
오류는 stderr에 `AFO 오류[코드]: 메시지`(공용 `AfoError`) 또는 `AFO 오류: 메시지`(그 밖) 한 줄로 출력합니다. 질문 중 Ctrl+C는 `AFO: 취소했습니다(Ctrl+C). …` 한 줄입니다(130). 안내형 `afo`·`afo undo`(ID 생략)의 멈춤 문구는 위 "빠른 시작"을 봅니다.

검증: `tests/cli.test.ts`(0·1·2와 오류 형식)와 `tests/cli-rules.test.ts`(제안→저장→자동 적용→재시작→켜기/끄기→이번만/저장 수정→forget→reset·손상 프로필, 0·1·2·4)가 실제 자식 프로세스와 temp `AFO_STATE_DIR`로 확인합니다.
`tests/cli-plan.test.ts`는 plan의 저장 파일·`loadSavedPlan` 결과와 출력 일치, 승인 코드 재계산, 두 번 실행의 같은 작업 ID 집합, 파일 하나 변경 뒤 바뀐 작업만 표시, 중복 그룹 keeper 유지, 참고 파일 비포함, 영구 삭제 문구, 순수 JSON stdout, 저장 프로필 결합, 마지막 사본 거부(1)·`--delete-last-copy` 허용·플래그 단독(2), 0·1·2 거부와 작업·참고 폴더 manifest 불변을 자식 프로세스로 확인합니다. plan이 따로 스캔·해시하지 않는 것은 컴파일된 `plan.js`의 정적 검사와 `tests/approvals.test.ts`의 `Analysis.scan` 테스트로만 확인합니다(프로세스 수준 I/O 계측 없음).
`tests/cli-apply.test.ts`는 자식 프로세스·합성 폴더·temp `AFO_STATE_DIR`로 plan → apply organize(비TTY `--confirm`) → 독립 manifest(목적지 sha256 일치·원래 경로 부재·다른 파일 불변) → runs → recover(빈 결과) → undo(원래 경로·해시·수정 시각 동일), `--confirm` 없음·틀린 코드·다른 방식 코드·`--yes`·잘못된 `--only` → 4/2와 무변경·승인 기록 없음, 같은 코드·포함 작업 재실행 → 4, `--only` 부분 실행, plan 이후 원본 수정(`FILE_CHANGED`)·목적지 선점(`DEST_EXISTS`, 덮어쓰지 않음) → 3과 나머지 처리, 영구 삭제 문구 없음 → 4·있으면 후보만 삭제하고 keeper 해시 유지·undo 거부(1), 테스트가 잡은 루트 잠금 → 1과 무변경·이후 재승인 실행, 두 자식 프로세스 동시 apply → 하나는 `LOCKED_BY_OTHER`(1), TTY 입력(프로세스 내 `runCli`)을 확인합니다. 실제 OS 휴지통은 `AFO_REAL_TRASH_TEST=1`일 때만 `afo-test-` 합성 파일 1개로 확인합니다(휴지통을 비우거나 읽지 않음). 실행 중 Ctrl+C(130)와 잠금 해제 실패·결과 저장 실패 안내는 CLI 자동 테스트가 없습니다(미검증). Windows는 미검증(CI 대기)입니다.
`tests/cli-guided.test.ts`는 대화형 `afo`를 프로세스 내 `runCli`(응답 함수)로 확인합니다: 드래그 경로 정리, 거부된 폴더 재질문·3회 실패 1·빈 입력 0, 메뉴 1 → 코드 입력 → 실제 이동(독립 manifest로 목적지 sha256·원래 경로 부재) → `undo`(ID 생략) → 원래 경로·해시·수정 시각 복구, 틀린 코드·빈 코드 → 4·변경 없음·승인 기록 없음, 할 일 없는 메뉴 선택 불가·번호 3회 실패 2, 질문 중 취소 130, 비TTY 인수 없음 → 도움말(질문 없음), 비TTY `undo`(ID 생략)의 0/4/`--confirm`, 심볼릭 링크로 실행한 진입점. `tests/duplicates-keeper.test.ts`는 사본 표시 인식과 기본 keeper 순서·결정성을, `tests/executor-undo.test.ts`는 새로 만든 빈 폴더 제거(깊은 순)·원래 있던 빈 폴더 유지·사용자 파일이 든 폴더 유지·같은 이름의 다른 폴더 유지·폴더 목록 없는 이전 실행 기록의 undo를 실제 파일로 확인합니다. 메뉴 2의 실제 OS 휴지통은 `AFO_REAL_TRASH_TEST=1`에서만 `afo-test-` 합성 사본 1개로 확인합니다. 실제 pty(이 Mac)에서의 드래그 입력·Ctrl+C는 수동 확인만 했습니다.
TTY 질문은 자식 프로세스에 pty가 없어 `run()`에 응답 함수를 넣는 프로세스 내 테스트로만 확인합니다. 130과 `PROFILE_CHANGED` 경쟁은 CLI 자동 테스트가 없습니다(미검증). 저장 API의 거부는 `tests/profiles.test.ts`, 두 프로세스 동시 저장·reset 경쟁은 `tests/verify-18-recheck.test.ts`(R18-20~22, 저장 API 직접 호출)에서 확인합니다.

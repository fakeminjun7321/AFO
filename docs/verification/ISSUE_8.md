# #8 정리 계획·일회성 배치 승인 독립 검증

역할: verifier. 날짜: 2026-10-26. 대상은 `origin/feat/8-plan-approval`의 `5675339`입니다.
검증 범위는 API(`packages/engine/src/plan.ts`, `packages/filesystem/src/approvals.ts`)입니다. CLI 연결(`plan`/`apply`)은 범위 밖이라 검사하지 않았습니다.
검증자는 제품 코드(`packages/`, `apps/`)와 builder 파일을 수정하지 않았고 `tests/verify-8.test.ts`와 이 문서만 추가했습니다.
기대값은 손으로 쓴 표입니다. plan ID·op ID·승인 코드는 검증 파일 안의 별도 canonical JSON + sha256으로 다시 계산했고 제품의 `canonicalJson`/`planHash`/`approvalCode`를 기대값으로 쓰지 않았습니다.

```text
Issue / PR / Commit: #8 / PR 없음(미생성) / 대상 5675339, 검증 브랜치 verify-8(로컬, push 안 함)
Environment: macOS 27.0.1 (26A434) arm64, 실물 Mac, Node v24.18.0. temp 볼륨 APFS(대소문자·정규화 구분 없음)
Fixture and baseline manifest: 테스트마다 realpath(os.tmpdir())/afo-test-* 아래 새 폴더에 work/(합성 파일 16개)와 state/(AFO 상태 폴더)를 만듦.
  자식 프로세스에는 AFO_STATE_DIR=<그 temp state>를 줌. baseline = tests/fixtures의 독립 manifest(경로·종류·크기·mtimeNs·sha256)
Steps or exact commands:
  git fetch origin && git checkout -b verify-8 5675339
  npm ci --ignore-scripts --no-audit --no-fund && npm run typecheck && npm test        (검증 테스트 추가 전)
  npm run typecheck && npm test                                                         (tests/verify-8.test.ts 추가 후)
Observed files / hashes / journal / exit status: 아래 표. 이번 범위에는 파일 실행·저널이 없음
Passed / Failed / Not run: 아래 완료 조건 표
Verification level: Unit-verified + macOS 실물 temp 파일·상태 폴더 검사(Physical, 이 Mac). Windows 미검증(CI 대기). CI(VM) 미실행
Not verified and reason: Windows 전체(이 Mac에서 불가), CLI plan/apply 경로(범위 밖), 실제 실행 직전 파일 재검증(#10 executor 범위)
Release blocker and unblock condition: 데이터 손실·승인 범위 확대·루트 이탈 결함은 없음. 관찰 O-1~O-7은 설계 확인 또는 후속 이슈 권장
```

## 실행 결과

| 단계 | 명령 | 종료 코드 | 결과 |
| --- | --- | --- | --- |
| 재현(5675339) | `npm ci --ignore-scripts --no-audit --no-fund` | 0 | 4개 패키지 설치 |
| 재현(5675339) | `npm run typecheck` / `npm test` | 0 / 0 | tests 186, pass 184, fail 0, skipped 2(실제 휴지통) |
| 검증 추가 후 | `npm run typecheck` / `npm test` | 0 / 0 | tests 208, pass 206, fail 0, skipped 2, todo 0 (verify-8: 22개 모두 pass) |
| 실행 후 확인 | `$TMPDIR/afo-test-*` 잔여 | — | 실행 전후 모두 1개(이 브랜치 테스트가 만든 것이 아님, 손대지 않음). 이 테스트의 잔여 없음 |

처음 실행에서 verify-8 3개가 실패했으며 모두 검증 코드의 잘못이었습니다: 취소 스캔 fixture에 `complete: true`를 남김(스키마 위반), 스키마를 깨는 plan 변조로 `PLAN_CHANGED`를 기대함, 손으로 만든 plan 파일 거부를 기대함(→ 관찰 O-2로 기록). 수정 후 22개 통과.

## 합성 fixture(work/)

| 파일 | 내용(바이트) | 손으로 쓴 기대 |
| --- | --- | --- |
| `a.pdf`, `b.pdf` | 같은 7 B | 중복 그룹 1, keeper `a.pdf`(경로 순서), `b.pdf` 삭제 후보 |
| `x.jpg`, `y.jpg`, `z.jpg` | 같은 8 B | 중복 그룹 2, keeper `x.jpg`, `y.jpg`·`z.jpg` 삭제 후보 |
| `movie.mp4`, `song.mp3`, `한글 파일.hwp` | 서로 다름 | `영상/`, `음악/`(프로필 사용 시 `내 음악/`), `문서/`로 이동 |
| `same.txt`, `sub/same.txt` | 다름 | 같은 목적지 `문서/same.txt` → 둘 다 review |
| `Note.md` + 기존 `문서/note.md` | 다름 | 대소문자만 다른 기존 파일과 충돌 → review, 기존은 keep |
| `café.txt`(NFD) + 기존 `문서/café.txt`(NFC) | 다름 | 정규화 차이 충돌 → review, 기존은 keep |
| `문서/existing.pdf` | 7 B(그룹 1과 크기만 같음) | 이미 정리됨 keep, 중복 아님 |
| `memo` | 확장자 없음 | review |

`all-duplicates` 기대: 삭제 3(b.pdf→keeper a.pdf, y.jpg·z.jpg→keeper x.jpg), 이동 3, 검토/유지 10, logicalBytes 45. trash/permanent 두 모드 모두 실제 파일에서 일치(V8-P1).

## 완료 조건별 판정 — #8

| 완료 조건 | 판정 | 근거(테스트) |
| --- | --- | --- |
| RuleProfile 버전·개인 규칙·목적지를 계획과 승인에 결합, 규칙 수정·비활성화·초기화·루트 변경 뒤 기존 승인 거부 | PASS | V8-R1: 저장 프로필(손으로 쓴 v2, `.mp3`→`내 음악`)로 만든 plan·승인에 `profileId/revision` 결합 확인. 규칙 끄기, 저장 수정 추가, 프로필 비활성화, 초기화, 비활성화→재활성화(ABA), 초기화→같은 프로필 재저장(ABA), 수정 추가→삭제(ABA), 프로필 파일 손상 8가지 모두 consume(organize·trash 둘 다)·issue·savePlan이 `PROFILE_CHANGED`, `.used` 표시 없음. V8-R2: 값이 같은 규칙 켜기(쓰기 없음)는 유지. 루트 변경은 V8-T2 |
| 이동/휴지통/영구 삭제/유지별 ID·이유·대상·예상 영향, plan hash/version | PASS | V8-P1: op 종류·목적지·keeper·검토 상태가 손 작성 표와 일치, `expected`가 실제 lstat(size·mtimeNs·dev·ino)와 sha256과 일치, op ID = sha256(op 정규 JSON)[0..16], plan ID = sha256(plan 정규 JSON, id 제외)을 독립 재계산해 일치, `formatVersion: 1`, 만료 = 생성 +60분 |
| 충돌·예약명·정규화 차이·중복 재정리·원본 보존, 예측 가능한 결과 경로 | PASS(macOS) | V8-P1: 같은 목적지 2개, 대소문자만 다른 기존 파일, NFD/NFC 차이 모두 review(덮어쓰기 없음), 이미 정리된 파일 keep, keeper의 이동은 보류(keep). 예약명은 #6 스캔에서 제외(V67-S1)라 계획에 도달하지 않음. Windows 예약명·대소문자 실물은 미검증 |
| 서비스의 일회성 승인 기록, 루트·세션·plan·선택·모드·유효기간 결합, 불리언·경로만으로 실행 불가 | PASS(관찰 O-2·O-3·O-6 참고) | V8-A2(MAC: 손 작성 JSON, 다른 ID로 복사, 작업 확대·모드·만료 연장·세션·프로필·grant 식별 편집, 추가 키 → 모두 `APPROVAL_INVALID`), V8-M3(`approved: true`, `yes`, `usedAt`, `expiresAt`, `rootPath`, `sessionId`, `operations`, `grant`, `id` 추가 키, 코드 누락·불리언, `null`·문자열·배열 입력 → `APPROVAL_INVALID`, 승인 파일 미생성), V8-A3(유효기간), V8-T2(루트), V8-M1(모드) |
| 승인 없음/위조/만료/재사용 부정 테스트 | PASS | 없음: V8-A1(무작위 UUID, 빈 문자열, `../plans/x`, 대문자, 200자, `secret`, 숫자 → `APPROVAL_MISSING`). 위조: V8-A2(위 + 다른 상태 폴더에서 서명한 기록, 다른 폴더의 secret으로 교체, secret 삭제, secret 재생성 뒤 이전 승인, secret 0644·링크 → 거부, 복원하면 미사용 상태로 유효). 만료: V8-A3(발급 +10분 정각 `APPROVAL_EXPIRED`, -1 ms 유효, 발급 전 시각 `APPROVAL_INVALID`, plan 만료 2분 전 발급 → 승인 만료 = plan 만료, plan 만료 시각 발급 거부, 2시간 전 plan 발급 거부). 재사용: V8-A4(두 번째 소비, JSON을 미사용으로 되돌림 → `APPROVAL_USED`). 동시: V8-A5(같은 프로세스 8개 동시 → 정확히 1 성공·7 `APPROVAL_USED`, 같은 시각에 시작하는 자식 프로세스 2개 × 3회 → 매번 정확히 1 성공), V8-A6(새 상태 폴더에서 동시 첫 발급 3개 모두 검증 통과) |
| plan·파일·모드 변경 부정 테스트 | PASS(파일 변경의 실행 거부는 #10 의존) | plan: V8-T1(작업 추가, 목적지 변경, keeper 변경 2종, 작업 추가+ID 재계산 후 원래 이름 저장, expected 변경+ID 재계산, grant inode·device·경로 변경, 잘림, plan 삭제 → 모두 `PLAN_CHANGED`, 원본 복원 시 그 승인 사용 가능). 루트: V8-T2(rename+mkdir → `FILE_CHANGED`, 루트 삭제, 이전 폴더를 가리키는 링크 → 거부, 원래 폴더 복귀 시 유효). 상태 폴더: V8-T3(루트 안·같음·루트를 포함 → `STATE_DIR_CONFLICT`, 루트 안으로 복사한 상태 폴더와 그곳을 가리키는 바깥 링크로 consume·issue → `STATE_DIR_CONFLICT`, 루트 manifest 불변). 파일: V8-P3(movie.mp4 내용 변경 → 새 plan에서 그 op ID만 바뀜, 이전 ID·이전 코드로 새 plan 승인 거부). 모드: V8-M1(섞인 선택·다른 종류 8가지 → `MODE_MISMATCH`), V8-M2(영구 삭제 문구 누락·빈 값·`영구삭제`·앞뒤 공백·이중 공백·다른 문구, 코드 1글자 다름·대문자·다른 모드/plan/부분집합·길이 다름 → `APPROVAL_INVALID`) |
| 전부 삭제 선택 부정 테스트 | PASS(관찰 O-4) | V8-K1: `all-duplicates`에서 그룹마다 keeper ≥1이 남고 어떤 op 대상도 아님, 모든 후보 op의 keeper = suggestedKeep. keeper를 explicitDeletes에 추가, 루트 전체 파일을 explicitDeletes, 후보에 keeper 포함, 그룹 밖 파일, 빈 후보 → `KEEPER_INVALID`. chooseKeeper(z.jpg) 후 새 plan: 삭제 = b.pdf→a.pdf, x.jpg·y.jpg→z.jpg(손 작성), diff는 바뀐 2개만 added, 이전 코드 거부, 이전 승인은 이전 plan의 묶음만 반환 |
| 유효한 동일 배치는 한 번 확인, 변경 항목만 재확인, 범위 확대 없음 | PARTIAL | 한 번 확인: V8-M1·V8-S1(모드별 전체 코드 1개로 전체 배치 승인, 순서 무관). 범위 확대 없음: V8-S1(부분 승인 1개·2개 → batch.operations가 정확히 그 부분집합, plan 밖·다른 plan·중복·빈·대문자 ID 거부). 변경 항목만 재확인: `diffPlans`가 바뀐 op만 added로 보고(V8-P3, V8-K1)하지만 새 plan은 전체 코드로 다시 승인해야 함. "바뀐 항목만 다시 보여 주기"는 CLI/GUI 표시 몫이라 이번 범위에서 미검증 |
| 서비스 호출 전후 작업 루트 무변경 | PASS | V8-W1: savePlan·issueApproval·consumeApproval과 거부 호출 전후 manifest 동일, 상태 폴더에는 `plans/`, `approvals/`(`<id>.json`, `<id>.used`), `secret`(0600)만 생김. V8-T3도 루트 안 상태 폴더 거부 시 쓰기 없음 확인 |
| plan 결정성 | PASS | V8-P2: 같은 파일 재스캔 + 같은 grant + 같은 now(JSON 왕복 입력)로 같은 plan. now +1 ms, 삭제 방식, 삭제 선택, 같은 폴더 재선택 grant는 다른 ID. 취소된 스캔·미리보기 → `CANCELLED`, 다른 세션 → `ROOT_FORBIDDEN` |
| Windows | NOT-RUN | 이 Mac에서 불가, CI 대기 |

## 관찰(결함 아님 또는 설계 확인 필요)

실행은 모두 fail-closed였고 승인 범위 확대·루트 밖 쓰기는 관찰되지 않았습니다. 아래는 coordinator 판단이 필요한 동작이며 테스트에는 진단(`t.diagnostic`)으로만 남겼습니다.

| ID | 관찰 | 재현 | 권장 |
| --- | --- | --- | --- |
| O-1 | `consumeApproval`은 파일 상태를 다시 확인하지 않음. 승인 뒤 파일이 바뀌어도 이전 plan의 묶음(이전 `expected`)을 반환 | V8-P3: 승인 → movie.mp4 수정 → consume 성공, `expected.size` 11 vs 실제 18 | ARCHITECTURE 불변 조건 3·5의 "파일 변경 시 실행 거부"는 #10 executor가 `expected`와 실제 파일을 대조해야 완성. #10 검증의 필수 사례로 넘김 |
| O-2 | plan 파일에는 MAC이 없어, 스키마에 맞고 hash가 일치하는 plan을 `plans/`에 손으로 쓰면 승인이 발급됨(승인 코드는 공개 계산식) | V8-T1 진단 `hand-written plan file in plans/ → approval issued` | 위협 모델상 상태 폴더 쓰기 권한자는 secret도 읽을 수 있어 O-3과 같은 부류. 문서에 한계로 명시하거나 savePlan에도 MAC 부여 검토 |
| O-3 | `.used` 표시를 지우고 승인 JSON을 미사용으로 되돌리면 다시 소비됨 | V8-A4 진단 `consumed again` | builder 주석의 위협 모델(상태 폴더 쓰기 권한자 제외)과 일치. #10 저널(성공 op 재실행 방지)이 2차 방어인지 #13에서 확인 |
| O-4 | `explicitDeletes`로 중복 그룹의 모든 파일을 직접 고르면 keeper 없이(null) 모두 삭제 계획됨 | V8-K2: `['a.pdf','b.pdf']` → 둘 다 delete, keeper null | CARRYOVER의 "직접 고른 파일은 keeper 없음" 규칙과 일치하지만 사본이 하나도 남지 않음. CLI/GUI가 "이 내용의 마지막 사본" 경고를 표시할지 결정 필요 |
| O-5 | 같은 폴더를 다시 선택(이전 grant 폐기, 새 grant)해도 dev/inode가 같으면 기존 승인을 사용할 수 있음. 반환 batch.grant는 새 ID | V8-G1 진단 | ARCHITECTURE 불변 조건 3은 "폴더 재선택 시 거부"라고 적음. 프로세스 간 CLI(`plan`→`apply`)에서는 grant ID가 이어질 수 없어 현재 설계는 식별(dev/inode) 결합임. 문서 문구를 맞추거나 재선택 시 승인 폐기 API 추가 결정 필요 |
| O-6 | 소비 프로세스의 세션은 검사하지 않음(다른 프로세스가 소비 가능). 결합 대상은 plan의 sessionId | V8-A5(자식 프로세스 소비 성공) | 프로세스 간 CLI에 필요한 설계로 보임. "세션 결합"의 뜻을 INTERFACES.md에 명시 권장 |
| O-7 | 스키마를 깨는 입력은 AfoError가 아니라 원시 오류로 거부됨: `savePlan`에 잘못된 plan → `ZodError`, `issueApproval`에 Date가 아닌 `now` → `TypeError` | V8-T3·V8-M3 진단 | fail-closed라 안전 문제는 아님. CLI 종료 코드 4(승인 거부)로 분류되도록 `PLAN_CHANGED`/`APPROVAL_INVALID`로 감싸기 권장. 영구 삭제 문구의 NFD 형태는 NFC로 정규화되어 허용됨(의도된 동작으로 보임) |

# #9 로컬 GUI(`gui`) 첫 구현 검증

대상: #9, 브랜치 `feat/9-local-gui`(기준 `433819d`). 날짜: 2026-10-29. 작성자가 직접 확인한 기록이며 독립 verifier 검증 전입니다.
범위는 CLI가 띄우는 **보기 전용 로컬 브라우저 화면**입니다. 화면에서 실행(apply·undo)·규칙 변경은 하지 않으며, 데스크톱 앱 패키징·배포는 범위 밖입니다.

## 구현한 범위

- `gui [<폴더>] [--port] [--no-open]`: 127.0.0.1 HTTP 서버, 무작위 토큰(URL `#` 뒤), Host·Origin 검사, strict CSP, 기본 브라우저 열기, Ctrl+C 종료
- 화면 5개: 미리보기, 정리 계획(계획 저장·승인 코드·`apply` 명령 복사), 개인 규칙, 실행 기록(파일 이름·`undo` 명령), 복구 점검
- 공용 함수 재사용을 위한 작은 리팩터링: `plan.ts`의 `createPlan`, `apply.ts`의 `runSummaries`·`recoverReport`. CLI 출력·종료 코드는 그대로입니다(전체 테스트 통과).

## 실행 환경과 결과

```text
Environment: macOS 27.0.1 (26A434) arm64, 실물 Mac, Node.js v24.18.0, npm 11.16.0
npm run typecheck  -> exit 0
npm test           -> tests 430 / pass 421 / fail 0 / skipped 9
node --test dist/tests/gui.test.js -> tests 6 / pass 6 / fail 0
```

skipped 9는 기존의 환경 조건 테스트(`AFO_REAL_TRASH_TEST=1`, 디스크 이미지 등)입니다. 새 `gui.test.ts`의 Ctrl+C 사례는 Windows에서만 건너뜁니다.

## 브라우저 수동 확인 (합성 폴더)

scratchpad에 만든 합성 폴더(문서·이미지·영상·음악·압축·설치 파일 14개, 내용이 같은 PDF 3개, `정리됨/수업/` 2개)와 별도 `AFO_STATE_DIR`로 Claude 데스크톱 앱 내장 브라우저에서 확인했습니다.

| 단계 | 확인한 것 | 결과 |
| --- | --- | --- |
| `gui <폴더> --no-open --port 47321` 후 주소 열기 | 열자마자 분석, 개수 요약(19개·이동 15·검토 4·중복 1묶음), 목적지 폴더별 묶음, 파일별 표 | PASS |
| 정리 계획 탭 → 중복 포함 → 계획 만들기 | 이동 13·휴지통 2·검토 4, 계획 ID·만료, 방식별 승인 코드와 `apply … --mode organize` 명령 | PASS |
| 화면의 명령·코드로 CLI `apply --mode organize --confirm <코드>` | 13개 이동 성공(exit 0). 화면은 파일을 바꾸지 않았고 CLI만 실행 | PASS |
| 실행 기록 탭 → 자세히 | 항목별 `이동함`·원래 위치 → 정리 위치, 공간 설명, `undo <실행 ID>` 명령 | PASS |
| 라이트 모드 + 375px 폭 | 가로 스크롤 없음(scrollWidth 375), 버튼·폼 배치 | PASS(체크박스가 늘어나던 CSS 결함을 고친 뒤 재확인) |
| 콘솔 | 오류 없음 | PASS |

## 검증하지 못한 것

| 항목 | 이유 |
| --- | --- |
| Windows 실물·Windows의 브라우저 자동 열기(`rundll32 url.dll`) | 이 Mac에서 확인할 수 없음. CI 결과로 대신하지 않음 |
| macOS `open`으로 기본 브라우저 자동 열기 | 테스트·수동 확인 모두 `--no-open`으로 실행함 |
| 복사 버튼의 실제 클립보드 기록 | 내장 브라우저에서 클립보드를 바꾸지 않음 |
| 1,000개 이상 폴더의 화면 응답성 | 측정하지 않음. 표는 500개까지 표시 |
| 키보드만으로 전체 흐름, 스크린 리더 | 탭·버튼은 기본 요소지만 전 과정을 확인하지 않음 |
| 독립 verifier 검증 | 아직 하지 않음 |

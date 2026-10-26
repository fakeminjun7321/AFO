# 상세 계획 과업 ↔ GitHub Issue 매핑

기준: 2026-10-26, main `1a82982`. 결정: [D11](DECISIONS.md)(Issue가 정본), [D12](DECISIONS.md)(하네스 정렬), [D13](DECISIONS.md)(MVD-B), [D14](DECISIONS.md)(#19 → H-0).
상세 계획 원문은 [DETAILED_PLAN.md](DETAILED_PLAN.md)(2차 수정, 참고 자료)입니다. 상세 계획과 이 저장소 문서가 다르면 GitHub Issue·PLAN.md·ARCHITECTURE.md·DECISIONS.md가 우선이며, 차이는 아래에 적습니다.
과업 단위 기계 판독 목록은 [`docs/status/tasks.json`](status/tasks.json)입니다. 진행 상태는 Issue에서 봅니다(여기에 진행률을 적지 않습니다).

## 1. 상세 계획을 저장소에 맞춘 변환 규칙

| 상세 계획 | 이 저장소 | 근거 |
| --- | --- | --- |
| 과업마다 Issue 48개 생성 | 기존 Issue #1–#19에 매핑, 없는 것만 신규(#22) | D11 |
| Electron 앱(U-1~U-4, IPC, 설치 파일) | CLI 우선. 화면 과업은 #9(M5)로 이동, CLI 과업 CLI-1~4 추가, SPK-5는 CLI 배포 방식 검증 | D10 |
| `packages/core`·`packages/executor` | `packages/engine`·`packages/filesystem` | ARCHITECTURE.md |
| Vitest | Node 24 기본 test runner | ARCHITECTURE.md |
| PM·developer·reviewer | coordinator·core-builder·interface-builder·verifier | HARNESS.md, D12 |
| 하루 5시간 일정, MVD 11/2 | MVD-B, MVD 11/3 | D13 |
| 영구 삭제 S1 권장·제외 | #12 범위 유지(**사용자 결정 대기**) | D16 |
| X-4 되돌리기 제외(MVD-B) | #10 범위 유지(**사용자 결정 대기**) | D17 |

`tier` 값: `MVD`(최소 시연 필수) · `MVP` · `하네스` · `후속`(M5 이후) · `제외(MVD-B)` · `결정필요`.

## 2. 매핑 표

2026-10-26 작업 분담: 제품 코드(`packages/**`, `apps/cli/**`, `tests/**`, `engine.yml`, `docs/adr/**`, `docs/verification/**`)와 #3·#4·#6·#7·#18·#8·#10·#11·#12·#13·#14는 **별도 코드 세션**이 구현·병합합니다. 이 세션(하네스·문서)은 해당 과업을 자동으로 고르지 않습니다(`externalOwner`). 역할 열은 하네스로 진행할 경우의 담당입니다.

| 과업 | 내용 | Issue | 역할 | tier | 진행 |
| --- | --- | --- | --- | --- | --- |
| HX-1 | 하네스 구축(에이전트·훅·스킬·상태 기록)과 시험 사이클 | #5 | coordinator | 하네스 |  |
| HX-2 | 하네스를 GitHub 설계에 맞춰 이식(역할·경로·Issue 동기화·CI) | #5 | coordinator | 하네스 |  |
| T-000 | 하네스 시험 과업: 시간 길이 표시 함수(sandbox) | #5 | core-builder | 하네스 |  |
| P-1 | 1쪽 기획서 작성·제출 | #2 | human | MVD |  |
| P-2 | Firebase Hosting 배포 연습(SPK-6) | #2 | human | MVD |  |
| P-4 | 합의 사항 기록, GitHub Issue 대조·과업 매핑(D11) | #1 | coordinator | MVD |  |
| ER-1 | 계획 외부 검토(ChatGPT, 4.2·4.4·5·6·13절) | #22 | human | MVD |  |
| P-3 | 주변 사용자 3명 인터뷰 | #2 | human | MVP |  |
| H-0 | H-0 남은 범위: 패키지 경계 검사·CLI 종료 코드·검사 연결(#4, #19 이후) | #4 | core-builder | MVD | 코드 세션에서 진행 중 |
| C-1 | 공용 계약 v1 + planHash 정규화(4.4) + T-DET 테스트 | #4 | core-builder | MVD | 코드 세션에서 진행 중 |
| H-1 | 최소 하네스: 지침·에이전트·훅 | #5 | coordinator | 하네스 |  |
| SPK-1 | 휴지통 동작·OS 복원 검증 | #3 | joint | MVD | 코드 세션에서 진행 중 |
| SPK-2 | 링크 방식 이동 검증 | #3 | joint | MVD | 코드 세션에서 진행 중 |
| SPK-5 | 서명 없는 설치 파일 | #15 | joint | MVP |  |
| A-1 | 합성 폴더 생성기 + 스냅샷 비교기 | #4 | core-builder | MVD | 코드 세션에서 진행 중 |
| SPK-3 | 권한·보안 기능 검증 | #3 | joint | MVP | 코드 세션에서 진행 중 |
| SPK-4 | Playwright Electron E2E | #9 | joint | 후속 |  |
| E-1 | 스캐너(F1) | #6 | core-builder | MVD | 코드 세션에서 진행 중 |
| E-2 | 토크나이저 + 확장자 표 150~200개 | #7 | core-builder | MVD | 코드 세션에서 진행 중 |
| E-3 | 규칙 엔진·기본 규칙·충돌 해결·이유 문장(F2) | #7 | core-builder | MVD | 코드 세션에서 진행 중 |
| E-4 | 계획 생성기: 4.4 정규화, 계획 단계 이름 충돌 해소(F5) | #8 | core-builder | MVD | 코드 세션에서 진행 중 |
| V-1 | 실행기 수용 테스트 + 실패 주입 장치 | #10 #13 | core-builder | MVD | 코드 세션에서 진행 중 |
| U-1 | 렌더러 골격·P1·P2(가짜 IPC) | #9 | interface-builder | 후속 |  |
| E-6 | 참고 폴더 규칙 추출(F3) | #18 | core-builder | MVD | 코드 세션에서 진행 중 |
| E-7 | 규칙 저장소·"이번만/이후에도"(F4·F6) | #18 | core-builder | MVD | 코드 세션에서 진행 중 |
| E-5 | 중복·큰 파일 후보(F7·F8) | #7 | core-builder | MVD | 코드 세션에서 진행 중 |
| X-1 | 실행기: 링크 방식 이동 M0~M5, 휴지통 T0~T2, L3, 6.3 정책 | #10 #11 | core-builder | MVD | 코드 세션에서 진행 중 |
| A-2 | 사후 감사기(L5, 6.1) | #13 | core-builder | MVD | 코드 세션에서 진행 중 |
| U-2 | P3 계획 확인(탭·상세·수정·새 규칙) | #9 | interface-builder | 후속 |  |
| X-2 | 승인 저장·L2·L4 + 메인 IPC | #8 | core-builder | MVD | 코드 세션에서 진행 중 |
| X-3 | 저널(JSONL+fsync)·정합 복구(5.5) | #10 #13 | core-builder | MVD | 코드 세션에서 진행 중 |
| U-3 | P4·P5·P6 승인(충돌 정책 선택)·실행·결과 | #9 | interface-builder | 후속 |  |
| ER-2 | X-1·X-3 상태 기계 외부 검토 | #22 | human | MVD |  |
| I-1 | 실제 IPC 연결, MVD 시나리오 | #14 | joint | MVD | 코드 세션에서 진행 중 |
| EV-1 | 임계값 실험·확정(7절) | #18 | joint | 제외(MVD-B) | 코드 세션에서 진행 중 |
| X-4 | 이동 되돌리기(F13) | #10 | core-builder | 결정필요 | 코드 세션에서 진행 중 |
| U-4 | P7 규칙 관리·시작 시 복구 안내 | #9 | interface-builder | 후속 |  |
| I-2 | 두 OS 실제 기기 검증(14.2 범주 6·7·8) | #14 | joint | MVP | 코드 세션에서 진행 중 |
| ER-3 | 통합 테스트 결과 외부 검토 | #22 | human | MVP |  |
| ER-4 | 릴리스 외부 검토(R-1 전, R-2 전 변경분) | #22 | human | MVP |  |
| R-1 | 릴리스 후보 v0.9(GitHub Releases) | #15 | joint | MVP |  |
| H-2 | 하네스 확장(외부 검토 패킷 자동화 등) | #5 | coordinator | 제외(MVD-B) |  |
| T-1 | 외부 사용자 1명 테스트·개선 | #16 | human | MVP |  |
| D-1 | 5분 소개 영상 | #16 | human | MVP |  |
| R-2 | 최종 릴리스 v1.0 + 버그 수정 예비 | #15 | joint | MVP |  |
| D-2 | 소개·다운로드 페이지, README, 최종 제출 | #16 | human | MVP |  |
| S2 | 미분류 상위 3개 후보 | #18 | core-builder | 제외(MVD-B) | 코드 세션에서 진행 중 |
| S3 | 임시·빈·미완료 다운로드 후보 | #7 | core-builder | 제외(MVD-B) | 코드 세션에서 진행 중 |
| S1 | 영구 삭제 모드(사용자 별도 승인 필요) | #12 | core-builder | 결정필요 | 코드 세션에서 진행 중 |
| S5 | 복사 방식 이동(다른 볼륨·링크 미지원) | 없음(후속) | core-builder | 후속 |  |
| W-1 | 브라우저 시연 페이지 | #15 | interface-builder | 제외(MVD-B) |  |
| CLI-1 | CLI 분석·미리보기 출력(이유·충돌·보호 표시, 한국어/JSON) | #6 #7 | interface-builder | MVD | 코드 세션에서 진행 중 |
| CLI-2 | CLI 계획 수정(목적지 변경·제외·이번만/이후에도) | #8 #18 | interface-builder | MVD | 코드 세션에서 진행 중 |
| CLI-3 | CLI 배치 승인·실행·결과(충돌 정책 선택, 감사 결과 표시) | #8 #10 #11 | interface-builder | MVD | 코드 세션에서 진행 중 |
| CLI-4 | CLI 규칙 관리·미완료 작업 복구 안내 | #18 #13 | interface-builder | MVP | 코드 세션에서 진행 중 |

## 3. 대응 Issue가 없거나 겹치는 과업

| 구분 | 과업 | 처리 |
| --- | --- | --- |
| 대응 없음 → 신규 | ER-1~ER-4 외부 독립 검토 | [#22](https://github.com/fakeminjun7321/AFO/issues/22) 생성 |
| 대응 없음 → 후속 | S5 다른 볼륨 복사 이동 | BACKLOG "후속 범위"(교차 볼륨 이동 제외)와 일치. Issue를 만들지 않음 |
| 대응 없음 → 신규 과업 | CLI-1~CLI-4 | 상세 계획에 없음(Electron 전제). D10에 따라 기존 #6·#7·#8·#10·#11·#13·#18 안의 과업으로 추가 |
| 여러 Issue에 걸침 | X-1(#10 이동 + #11 휴지통), X-3·V-1(#10 + #13), CLI-1~4 | 과업 1개를 나누지 않고 주 Issue에 코멘트로 연결 |
| 한 Issue에 여러 과업 | #4(H-0, C-1, A-1), #5(HX-1, T-000, H-1, H-2), #7, #18 등 | 과업 단위 상태는 `docs/status/`, Issue에는 시작·완료 코멘트(D12) |
| 이미 구현된 부분 | #19 → PR #20(main 반영) | E-1·E-2·E-3·E-5·E-6과 #4 일부의 기반. 해당 과업에 노트로 표시하고 남은 범위만 구현(D14) |
| 상세 계획보다 Issue가 넓음 | #12(영구 삭제), #10(되돌리기) | MVD-B 제외 대상이지만 Issue 완료 조건에 있음 → D16·D17 결정 대기 |
| 과업이 없는 Issue 조건 | #3의 "선택 영구 삭제 기술검증" | SPK-1에 포함하지 않음. D16 결정에 따라 SPK-1에 추가하거나 #3에서 제외 |

## 4. P-4 합의 사항 기록(상세 계획 17.1)

| # | 항목 | 상태 |
| --- | --- | --- |
| 1 | 1인 하루 가용 시간(G0) | 확정: 3–4시간 → MVD-B(D13) |
| 2 | 각자 실제 기기 OS | **미확인** — 두 사람의 Windows·macOS 기기 |
| 3 | 역할 분담 | 제안 유지(상세 계획 11.1). GitHub assignee 미배정. 장민서 GitHub 계정(collaborator `minseo1dd-dshs` 추가됨) 본인 확인 필요 |
| 4 | MVP·MVD 범위, LLM 미포함 | 확정: MVD-B. LLM 미포함은 D05와 일치 |
| 5 | GitHub Issue와의 차이 | 이 문서(D11) |
| 6 | 오늘 제출물(P-1·P-2) | **미확인** — 제출 여부 |
| 7 | 외부 검토 운영 | #22 생성. 검토자·계정 미정 |
| 8 | 실행 중 이름 충돌 기본값 | 제안 `skip` 유지, C-1에서 계약으로 확정 |
| 9–14 | 후속 기한 항목 | 해당 과업 전까지(14번은 D16으로 앞당겨 질문) |
| 15 | UI 프레임워크·Claude Code GitHub Action | UI는 D10으로 보류. Action 미사용 |
| 16 | 동기화 방식 | 미정 |

## 5. H-0 남은 범위(제안, 승인 전 구현하지 않음 · 경로는 코드 세션 소유)

상세 계획 H-0(모노레포 골격·패키지 경계 린트·테스트·기본 CI)과 #4 완료 조건을 main과 비교했습니다.

| 조건 | main 현황 | 남은 일 |
| --- | --- | --- |
| TS strict·패키지 분리 | 충족(#20) | 없음 |
| 테스트 실행기·두 OS CI | 충족: Node test runner, `engine.yml` windows·macos | 하네스 자체 테스트 CI(이번 PR에서 추가) |
| lockfile·Node 버전 고정, 새 checkout 설치 방법 | 충족: Node 24, `npm ci` README | 없음 |
| 패키지 경계 린트(금지 import 시 실패) | **없음** | `contracts`는 I/O 모듈 금지, `engine`은 `node:fs` 금지, `apps/cli`는 정책 재구현 금지 경계를 검사하는 스크립트와 부정 테스트 |
| README에 실제 scripts와 **종료 코드** | scripts는 있음, 종료 코드 없음 | CLI 종료 코드 정의·문서·테스트 |
| run-checks와 프로젝트 스크립트 연결 | 하네스는 `lint`가 없으면 건너뜀 | `npm run lint`로 경계 검사 노출 |

C-1(Plan·Approval·Journal·Report 스키마, planHash 정규화, onRuntimeConflict, 오류 코드, ReferenceGrant)과 A-1(합성 폴더 생성기·스냅샷 비교기, `tests/helpers.ts` 확장)은 H-0 다음 과업입니다.

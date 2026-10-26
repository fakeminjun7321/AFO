# Firebase 기반 첫 검증 기록

이 문서는 PR #33 당시 v1 저장 형식의 기록입니다. 검토 후 v2 변경·회귀 검증은 [PR 검토 결함 수정](../docs/verification/PR_REVIEW_FIXES.md)과 현재 README를 참고합니다.

날짜: 2026-10-26. 이슈 #25, branch `feat/firebase-foundation`.

## 확인한 결과

- `npm test`: 타입 검사·빌드 포함, 단위 검사 5개 통과, 실패/건너뜀 0.
- `npm run test:emulator`: Auth/Firestore/Hosting Emulator 통합 검사 5개 통과, 실패/건너뜀 0.
- 실제 Auth Emulator 로그인→본인 규칙 저장·재조회·수정→stale revision 거부→메타데이터 삭제를 수행했다.
- 미인증/다른 사용자의 읽기·쓰기·삭제, raw SDK의 잘못된 필드·경로·시각·버전 쓰기를 거부했다.
- 규칙 최대 20개를 실제 저장·조회하고 1개로 줄여 이전 문서가 제거되는지 확인했다.
- 초기 배열 단위 정책에서 발견한 평가 한도 문제를 문서 단위 검사로 수정했다. 한도 오류가 나오면 실행기가 실패하도록 했고 마지막 통합 실행에 한도 오류가 없음을 확인했다.

환경은 실제 Mac, Node.js 24, JDK 26이며 Firebase SDK 13.1.0, Firebase CLI 15.34.0을 고정했다. Emulator 결과는 **Simulator-verified** 범위다. 실제 Firebase Auth/Firestore나 Windows 실행을 검증한 것이 아니다.

## 실제 Firebase 자원과 미리보기

프로젝트 `afo-hackathon-2026-7321`을 생성했고 Hosting의 **setup 미리보기 채널만** 배포했다. 운영 Hosting 채널, 실제 Firestore 데이터베이스, Auth 제공자는 배포/구성하지 않았다.

- URL: https://afo-hackathon-2026-7321--setup-0seg40g2.web.app
- 만료: 2026-11-02
- 실제 HTTP 확인 1회: 200, redirect 0, 예상 페이지 내용 일치.
- 브라우저 시각 검수: **미검증**. 숨김 브라우저 초기화가 커널 파일 오류로 실패해 다른 화면 조작으로 우회하지 않았다.

이 페이지는 연결 확인용이다. 로그인, 클라우드 규칙 관리 화면, 로컬 파일 처리, URL에서 전체 AFO 동작이 완성됐다는 증거가 아니다.

## 다음 연결에서 필요한 것

실제 DB 위치·로그인 제공자와 사용자 자격 증명 저장 방식을 정하고 Firestore/Auth를 구성해야 한다. 현재 CLI 명령·공용 계약에는 이 패키지를 연결하지 않았다. CloudRuleSet은 로컬 Profile의 절대 경로·참고 파일명·승인 자료를 담지 않는 별도 포맷이다.
CLI와 GUI는 다운로드한 자료를 로컬 계약으로 다시 검사하고 사용자의 분류·파일 작업 승인을 별도로 받아야 한다.

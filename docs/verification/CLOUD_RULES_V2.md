# 공개 클라우드 규칙 v2 전환 — 2026-10-26

이슈 #37. 사용자가 기존 자료 점검·보존 후 v2 전환, 합성 계정 한 개의 실제 저장·조회·접근 경계 검증과 테스트 자료 정리를 승인했다. 기준 main은 PR #38이 병합된 `f1767ad`, 공개 사용자 경로를 검증한 앱 소스는 `bf13dbb`이다. 이후 변경은 브라우저 보관 상태 문구와 문서뿐이다.

## 기존 자료와 규칙 보존

- 프로젝트 `afo-hackathon-2026-7321`, `(default)` Firestore, 서울. 요금제·위치·DB 설정·Auth 제공업체는 바꾸지 않았다.
- `users`의 missing parent 포함 문서 목록과 루트 collection IDs를 각각 읽었다. 사용자 문서 0, 루트 컬렉션 0, 다음 페이지 없음. 배포 직전에 같은 점검을 한 번 더 수행했고 결과도 동일했다.
- 점검 응답과 기존 release/source를 접근 제한한 작업 산출물에 저장했다. 데이터가 없으므로 사용자 문서의 삭제·수정·형식 이관은 하지 않았다.
- 기존 규칙 SHA-256: `90b237209d0e3af18fed24171712d085129432e2f50426395d53b6adf251043b`.
- 새 규칙 SHA-256: `9515dd27624c7c92d01465f3d41690da09d6d88c6d226ff1c35ddabe04a1b12a`.
- `firebase deploy --only firestore:rules --project afo-hackathon-2026-7321 --config firebase/firebase.json --non-interactive`로 기존 main의 v2 규칙만 배포했다. Firebase 패키지 구현과 루트 lockfile은 수정하지 않았다.
- 배포 후 release와 source를 다시 읽었으며 소스 전체와 해시가 일치했다. ruleset: `0a55e637-c9d1-4d1c-bddd-2a8b672b1a4a`.
- 이전 aggregation API의 400 오류는 같은 경로로 반복하지 않았다. 이번에는 별도 목록 API로 빈 상태를 확인했으며, 이전 오류의 원인을 확정했다고 주장하지 않는다.

## 구현과 검증 수준

**Implemented**: `services.public.json`의 `cloudRules=true`, 저장 형식 2를 확인한 공개 빌드에서 기존 Firebase repository v2를 연결한다. `VITE_AFO_CLOUD_RULES=disabled`로 클라이언트 연결을 끌 수 있다. 서버 권한 검사는 Security Rules가 담당한다. 자동 업로드는 없으며 사용자가 불러오기·저장하기를 선택한다. 브라우저 보관 전 상태 문구를 클라우드 저장 결과와 구분했다.

**Unit-verified**: Firebase 단위 6개, 웹사이트 단위 3개 통과. production/Emulator 빌드·타입 검사 통과.

**Simulator-verified**: Firebase Auth/Firestore/Hosting Emulator 통합 9개, 웹사이트 headless 브라우저 시나리오 2개 통과. 최대 20개·불완전 게시 거부·버전 충돌·두 인증 사용자 사이의 읽기/쓰기/삭제 거부는 Emulator에서 확인했다. 최초 Emulator 다운로드를 종료한 실행은 성공으로 세지 않았고, 기존 동일 버전 캐시를 사용한 새 실행에서 실제 테스트 9개를 확인했다.

**Physical-device-verified**: 실제 Mac의 별도 headless Chromium에서 아래 공개 Firebase 사용자 경로와 서버 자료를 확인했다. 사용자의 기존 창·탭·마우스·키보드를 조작하지 않았다. 실물 휴대폰 검증은 아니다.

1. 공개 `/signup`에서 합성 이메일 계정 한 개를 생성하고 `/account`에서 같은 이메일을 확인했다.
2. `/rules`에서 빈 상태를 불러오고 합성 규칙을 클라우드 버전 1로 저장했다. 별도 관리 API로 metadata의 formatVersion=2/revision=1과 실제 자식 규칙 내용을 조회했다.
3. 새로고침 뒤 로그인 유지와 클라우드 재조회로 규칙을 복원했다. 목적지를 수정해 버전 2로 저장한 뒤 서버 metadata와 자식 내용을 독립적으로 다시 확인했다.
4. 같은 인증 계정의 본인 문서 직접 조회는 HTTP 200, 다른 UID namespace 직접 조회는 403, 비로그인의 실제 본인 문서 조회도 403이었다. 두 번째 실제 인증 계정은 생성하지 않았다.
5. 로그아웃 뒤 비로그인 규칙 화면에서 이전 계정 규칙과 클라우드 저장 버튼이 보이지 않았다.
6. 1440px·390px 렌더를 확인했다. 내려받은 JS/CSS 8개가 해당 production dist와 일치했고 브라우저 JS 오류는 없었다.

## 테스트 자료 정리

합성 UID의 `personal` metadata와 자식 규칙만 updateTime precondition에 결합해 삭제했다. 그 다음 검증 도구의 HTTP 옵션 객체 재사용 때문에 GET 확인이 요청 전에 실패했다. 삭제를 반복하지 않고 새 요청 옵션으로 metadata 404·자식 문서 0을 읽은 뒤, 아직 남아 있던 정확한 합성 UID 계정만 삭제했다. 계정 재조회 부재와 루트 컬렉션 0도 확인했다. 실제 사용자 계정·자료는 변경하지 않았다. 최초 실패 기록과 정리 재확인 기록은 모두 보존했다.

## 배포와 트래픽

기존 `website-design` preview만 갱신했다. live/setup 채널은 그대로다. 공개 주소는 [나의 정리 기준](https://afo-hackathon-2026-7321--website-design-l2p0zktg.web.app/rules)이다. Google OAuth 설정은 변경하지 않았다.

이번 실제 경로 검증은 문서 접속/새로고침 2회, 브라우저 요청 총 37건(Hosting 14·Auth 3·Firestore 20), 별도 직접 권한 조회 3건이었다. 자료·규칙 점검/readback/정리는 별도 관리 요청 21건이다. CLI 배포·인증 갱신·GitHub 통신은 이 사용자 경로 집계와 구분한다. 이전 1차 공개 검증의 17건을 합치면 이 채팅의 관측된 사용자 경로 요청은 누적 57건이며, 별도 관리 요청은 누적 27건이다. 부하 검사·크롤링·429 재시도는 하지 않았다.

## Not verified / 미검증

실제 Google OAuth와 관리자 본인 인증, 서로 다른 두 실제 인증 계정의 기존 자료 교차 접근, 실물 휴대폰·Windows, 로컬 CLI 규칙 자동 적용·실제 파일 작업은 이번 검증에 포함하지 않았다. 서로 다른 두 계정의 접근 경계는 Emulator 결과와 실제 한 계정의 다른 UID 경로 거부 결과로 나누어 보고한다. 기존 v1 자료가 있는 환경의 실제 이관도 수행·검증하지 않았다.

# AFO 웹사이트

한국어 AFO 소개·샘플 체험·개인 규칙 웹사이트입니다. 검정·흰색·주황색과 홈의 사진/폴더 구도는 유지하고, 기능 화면은 같은 제목 크기·여백·메뉴 체계로 정리했습니다.

## 화면 구성

| URL | 용도 |
| --- | --- |
| `/` | 제품 소개와 체험 진입 |
| `/demo` | 샘플 파일 6개의 분류 전후 비교 |
| `/rules` | 개인 규칙 편집·브라우저 저장·클라우드 저장·JSON 교환 |
| `/help` | 사용 방법과 FAQ |
| `/login`, `/signup`, `/reset-password` | 이메일/Google 인증과 비밀번호 재설정 요청 |
| `/account` | 계정·역할 확인·로그아웃 |
| `/admin` | 인증된 운영 계정과 접근 권한 확인 |

헤더는 직접 체험·나의 규칙·도움말을 제공하고 로그인/계정 버튼을 별도로 둡니다. `/guide`와 `/faq`는 `/help`로 이동합니다. 로그인은 한 칸의 폼으로 구성하며, 규칙 화면의 JSON 기능은 접힌 상세 항목에 보존합니다. 브라우저 뒤로 가기·직접 URL·새로고침을 지원합니다.

**웹사이트에서 실제 사용자 파일을 읽거나 이동·삭제하지 않습니다.** 체험 결과는 고정 샘플이며 규칙 저장은 파일 변경 승인이 아닙니다. 규칙 엔진·저장 계약은 공용 모듈을 재사용합니다.

## 인증과 관리자

- 실제 Firebase 프로젝트: `afo-hackathon-2026-7321`, 등록 앱: `AFO Web`.
- 이메일/비밀번호와 Google 제공업체가 활성화돼 있습니다. 공개 앱 이름은 AFO, 지원 이메일은 사용자 승인한 운영자 주소입니다.
- 승인된 `website-design` 미리보기 호스트만 기존 Firebase authorizedDomains 목록에 추가했습니다. OAuth의 기본 프로필·이메일 외 추가 scope를 요청하지 않습니다.
- Google 버튼은 `GoogleAuthProvider`/`signInWithPopup`을 사용합니다. 팝업 취소·차단·기존 인증 방식 충돌을 처리합니다. 공식 Google 로고 자료를 사용했습니다.
- 운영자 계정은 사용자 지정 이메일로 서버에 비밀번호 없이 생성하고 custom claim `admin: true`를 부여했습니다. `email_verified`를 대신 true로 바꾸지 않았습니다. 실제 Google 본인 확인을 마쳐야 관리자 화면에 접근합니다.
- 프런트엔드의 관리자 이메일 목록·임의 비밀번호·관리자 서비스 계정 키는 없습니다. 서버 발급 토큰의 `admin === true` 및 `email_verified === true`를 확인합니다.
- `/admin`은 계정과 권한 확인 범위입니다. 회원 차단/삭제·타인 규칙 편집·파일 실행 등 관리 API는 아직 제공하지 않습니다. 클라이언트 route guard는 서버 권한 강제 장치가 아니며, 이후 관리 API/Rules에서 같은 조건을 별도로 강제해야 합니다.

## 개인 규칙과 클라우드

기존 #38/#39 변경을 보존했습니다. 규칙은 브라우저의 계정별 보관함에 저장하거나 웹 교환용 JSON으로 옮길 수 있습니다. v2 공용 Firebase repository로 로그인 사용자의 Firestore 저장·조회·수정을 연결하며 버전 충돌/결과 불명 상태는 재조회 전까지 저장을 거부합니다. 이 UI 정리에서 Firestore 보안 규칙이나 IAM은 변경하지 않았습니다. 클라우드 활성화와 실제 데이터 검증의 근거는 `docs/verification/CLOUD_RULES_V2.md`에 있습니다.

## 실행과 검증

Node.js 24에서 먼저 저장소의 `firebase` 패키지와 이 디렉터리에 `npm ci`를 실행합니다. 아래 명령은 이 디렉터리 기준입니다.

```sh
npm run dev
npm run build
npm test
npm run build:emulator
npm run test:e2e
```

개발 서버는 http://127.0.0.1:15173 입니다. 일반 빌드는 실제 Firebase, emulator 모드는 demo 프로젝트와 전용 로컬 Auth/Firestore/Hosting을 사용합니다. `dist`와 `dist-emulator`는 분리하고 emulator 빌드를 외부 호스트에서 실행하면 거부합니다. 테스트는 개인 파일 대신 합성 자료를 씁니다.

### 확인한 수준

- **Implemented:** 공통 메뉴·별도 경로·중앙 로그인 폼·Google 버튼·관리자 역할 확인·규칙 편집과 저장 기능이 있습니다.
- **Unit-verified:** 웹 규칙 교환·경계·손상 자료 거부 검사 3개 통과.
- **Simulator-verified:** Auth/Firestore Emulator의 사용자 경로 2개 통과. 규칙 저장·재조회·계정 분리·오프라인 불명 결과·버전 충돌을 포함합니다. Google popup의 합성 identity 연결과 관리자/일반 사용자 구분도 앞선 Emulator 검사에서 확인했습니다.
- **실제 서비스 확인:** 이메일 가입·로그인·새로고침 세션 유지·합성 계정 정리는 실제 Firebase에서 확인했습니다. Google 제공업체 활성화와 미리보기 도메인 등록을 서버 설정으로 재조회했고, 공개 버튼에서 `accounts.google.com`의 실제 로그인 화면까지 도달했습니다.
- **Not verified / 미검증:** 개인 Google 계정의 최종 동의·Firebase 로그인 완료·실제 관리자 진입, 실물 휴대폰, 비밀번호 재설정 메일 실제 수신, 웹과 로컬 파일 실행 연결. Google 로그인 화면 도달을 최종 OAuth 인증 성공으로 표현하지 않습니다.

이번 UI 정리는 1440×900·390×900·320×900에서 다섯 주요 화면의 H1·넘침·기능 링크·콘솔 오류를 확인했습니다. IAB의 기존 배율에서 캡처 오류가 있어 별도 headless Chromium으로 전후 렌더를 검수했습니다. 사용자 창·클립보드·줌 설정을 바꾸지 않았습니다. 최신 캡처와 검수 JSON은 이 채팅의 작업 산출물 폴더에 보관합니다.

## Hosting

[공개 미리보기](https://afo-hackathon-2026-7321--website-design-l2p0zktg.web.app)

승인된 프로젝트/사이트의 `website-design` 채널에만 배포하며 `--no-authorized-domains`를 명시합니다. CSP는 정확한 Firebase/Auth/Firestore origin과 Google helper script를 허용합니다. wildcard·unsafe-inline·unsafe-eval을 추가하지 않았습니다.

폰트는 Pretendard 1.3.9(OFL-1.1), 라이선스 동봉. Google 로고 원본: https://developers.google.com/static/identity/images/g-logo.png

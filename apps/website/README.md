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
- `/admin`은 계정·권한 확인과 읽기 전용 사용자/서버 조회 화면입니다. 조회 API는 로컬 검증을 마쳤지만 공개 배포 전이므로 현재 공개 화면은 연결 대기와 Firebase 콘솔 링크를 제공합니다. 회원 차단/삭제·타인 규칙 편집·파일 실행 API는 제공하지 않습니다. 클라이언트 route guard는 서버 권한 강제 장치가 아니며, 이후 관리 API/Rules에서 같은 조건을 별도로 강제해야 합니다.

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

### 최신 공개 배포 및 Google 확인 범위

- 앱 소스: `9b1393f`, Hosting version: `cf60216f01c8c911`, preview 만료: 2026-11-02 22:33:05 Asia/Seoul.
- 이번 수정에서 공개 앱 문서 접속은 2회, Google 로그인 popup 열기는 2회입니다. 마지막 확인의 브라우저 전체 관측 요청은 24건입니다. 앞선 확인은 메인 프레임만 10건을 수집했으므로 이를 전체 합계로 더하지 않습니다. 설정/계정 관리 API와 배포 트래픽은 별도입니다.
- 최신 공개 화면에서 3개 메뉴, 도움말 통합, JSON 접기/펼치기, 샘플 기준 변경, 모바일 넘침 없음을 확인했습니다.
- Google 제공업체 저장 뒤 실제 OAuth popup의 `accounts.google.com` 이메일 입력 폼까지 확인했습니다. 개인 자격 증명은 입력하지 않았습니다. 메인 UI runtime 오류는 없었습니다.
- 마지막 전체 네트워크 관측에서 기본 authDomain의 `/__/firebase/init.json` 요청 1건이 404였습니다. 이 요청이 있었어도 Google 이메일 입력 화면에는 도달했습니다. 이를 최종 OAuth callback 성공의 근거로 삼지 않으며, 본인 인증 완료 단계는 여전히 미검증입니다. 사용자 승인 없이 기본 live 사이트를 배포하거나 Auth helper를 우회하지 않았습니다.
- 새 인증 방식을 추가할 때는 제공업체 활성화·정확한 도메인 허용·실제 인증 화면을 확인한 뒤 공개 버튼을 배포하는 순서를 사용합니다. 이번에 버튼을 먼저 공개해 사용자가 실행할 수 없었던 상태를 운영 설정과 검증 순서에 반영했습니다. 다음 독립 작업에서의 재발 감소 효과는 아직 확인하지 않았습니다.

## 안내·자료와 관리자 조회 추가

현재 `/resources`가 안내 허브이며 `/downloads`에서 실제 ZIP/예시 JSON을, `/notes`에서 기능·검증·다음 작업 기록을 제공합니다. 홈에는 현재 제공하는 세 기능과 테스트 자료 진입을 추가했습니다. 합성 ZIP은 파일7개·예시 규칙·사용법·manifest의 총10개 항목이며 CRC·경로·SHA256·중복·PNG/WAV 형식을 검증했고 실제 다운로드와 규칙 가져오기까지 확인했습니다.

관리자 API의 source와 배포 조건은 `server/README.md`에 있습니다. Unit-verified는 웹3+서버3=6개, Simulator-verified는 전체 브라우저 시나리오4개입니다. 미로그인·일반 사용자·이메일 미확인 관리자 HTTP 거부, 관리자 실제 목록·runtime·DB 읽기를 포함합니다. 합성 데이터의 Emulator 결과이며 공개 관리자 정보 조회 완료로 확대하지 않습니다.

**Blocked / 차단됨:** 공개 관리자 API는 billingEnabled=false로 Blaze/결제 연결 및 최소 읽기 권한 서비스 계정 배포 승인을 기다립니다. 공개 UI의 adminApi=false를 유지합니다. 무료 Firebase 콘솔 조회 링크는 제공하며, 공개 서버 데이터나 사용자 수를 가짜로 채우지 않습니다. 마케팅·안내·다운로드 페이지는 이 제약과 독립적으로 배포합니다.

### 자료실 공개 검증 (2026-10-27)

앱 소스 cef4df5, Hosting version 60c4032c3c2ee0fe, preview 만료 2026-11-03 08:42:33 Asia/Seoul. 공개 자료실→ZIP/JSON 다운로드→규칙 가져오기→브라우저 저장→새로고침을 확인했습니다. ZIP 해시와 JSON 규칙 유지가 일치했고 모바일 개발 노트도 확인했습니다. 문서 접속2+의도적 다운로드2, 브라우저 전체 관측12건, runtime 오류0입니다. 공개 관리자 API 요청은 0이며 결제/요금제/IAM/Functions 공개 배포는 변경하지 않았습니다.

# AFO 웹사이트

[이슈 #32](https://github.com/fakeminjun7321/AFO/issues/32), [PR #35](https://github.com/fakeminjun7321/AFO/pull/35). [SWSH](https://www.joinswsh.com/)를 참고한 검정·흰색·주황색 디자인을 유지하고, 2026-10-26 후속 요청에 따라 화면을 별도 URL로 분리했습니다.

## 화면과 제공 기능

| URL | 내용 |
| --- | --- |
| `/` | 기존 디자인의 소개 화면 |
| `/guide` | 사용 방법 |
| `/demo` | 합성 샘플 6개 분류 미리보기·기준 변경·초기화 |
| `/faq` | 자주 묻는 질문 |
| `/login`, `/signup` | Firebase 이메일·비밀번호 로그인·회원가입 |
| `/reset-password` | 비밀번호 재설정 메일 요청 |
| `/account` | 실제 로그인 계정 표시·로그아웃, 비로그인 접근 시 로그인 화면으로 이동 |

메뉴는 페이지를 이동하며 브라우저 뒤로 가기와 새로고침을 지원합니다. Hosting rewrite는 각 경로에서 index.html을 제공합니다. 로그인 없이도 샘플 체험을 사용할 수 있습니다.

**실제 파일을 읽거나 이동·삭제하지 않습니다.** 샘플은 설명용으로 미리 정한 결과입니다. 개인 규칙은 `/rules`에서 편집·브라우저 보관·JSON 교환할 수 있습니다. 공개 Firestore 연결과 로컬 CLI 자동 적용은 아직 제공하지 않습니다. 공용 엔진·Firebase 연동 패키지·루트 lockfile은 수정하지 않습니다. 웹사이트는 기존 Firebase 패키지를 file dependency로 사용합니다.

## 실행과 빌드

Node.js 24 환경에서 이 디렉터리 기준:

```sh
npm --prefix ../../firebase ci --ignore-scripts --no-audit --no-fund
npm ci --ignore-scripts --no-audit --no-fund
npm run build:shared
npm run dev
npm run build
```

개발 서버는 http://127.0.0.1:15173 입니다. 일반 빌드는 등록된 `AFO Web` 앱의 실제 Firebase Auth에 연결합니다. 브라우저 식별용 공개 설정은 `src/config/firebase.public.json`이며 서비스 계정·관리자 자격 증명은 없습니다. 실제 비밀번호와 인증 토큰은 소스·로그에 저장하지 않으며 세션은 Firebase SDK가 관리합니다.

## 격리된 Auth 검증

```sh
npm run build:emulator
node scripts/start-emulators.mjs
```

http://127.0.0.1:15183 에서 확인합니다. 이 빌드는 `demo-afo-website`와 Auth Emulator 19103·Firestore Emulator 18103만 사용합니다. `emulator` 모드를 로컬 외부 주소에서 실행하면 시작을 거부합니다. Emulator 결과 디렉터리는 `dist-emulator`, 공개 배포용 디렉터리는 `dist`로 분리했습니다. Emulator에서 실제 계정·외부 메일을 사용하지 않습니다.

2026-10-26 로컬 검증:

- `npm run build`, `npm run build:emulator`, TypeScript 검사 통과.
- IAB의 `/login` 접근성 구조 확인. 기존 origin의 25% 배율에서 캡처가 불안정하므로 사용자 줌 설정을 바꾸지 않고 별도 headless Chromium으로 렌더·동작 검증.
- 1440×900, 390×844, 320×700에서 7개 공개 경로 직접 접속·새로고침, 페이지당 H1 하나, 가로 넘침 없음, 샘플 체험 및 모바일 메뉴 이동 확인.
- Firebase Auth SDK → 실제 Auth Emulator의 가입·로그인·로그아웃·잘못된 비밀번호·새로고침과 새 탭의 세션 유지 검증. 서버의 계정 레코드를 별도 조회해 생성된 UID 확인. 비밀번호 불일치는 서버 요청 전에 차단.
- 재설정 요청 후 Emulator의 PASSWORD_RESET OOB 레코드 확인. 실제 메일 배달 검증은 아님.
- 결과와 최신 캡처는 이 채팅의 작업 산출물 경로에 보관했습니다. 과거 단일 페이지의 첫 배포 기록은 `verification/VERIFICATION.md`에 있습니다.

Implemented와 Simulator-verified(Auth/Hosting Emulator)를 구분합니다. 별도 단위 테스트·실물 휴대폰은 미검증입니다. 실제 클라우드 인증 결과는 아래에서 별도로 구분합니다.

## Hosting 및 실제 인증 상태

프로젝트 `afo-hackathon-2026-7321`, 사이트 `afo-hackathon-2026-7321`, 승인된 미리보기 채널 `website-design`.

[공개 미리보기](https://afo-hackathon-2026-7321--website-design-l2p0zktg.web.app)

공개 배포는 `firebase.json`의 dist만 사용하며 후속 배포에는 반드시 `--no-authorized-domains`를 명시합니다. 이번 이메일 인증에서는 OAuth·Google 로그인·허용 도메인 변경을 추가하지 않습니다. Auth 초기화와 제공업체 활성화는 Hosting 배포와 다른 변경입니다.

사용자가 실제 이메일 인증 활성화와 임시 합성 계정 한 개의 생성·검증·삭제를 승인했습니다. 서버 config에서 `signIn.email.enabled=true`, `passwordRequired=true`를 적용하고 재조회했습니다. 허용 도메인은 변경하지 않았습니다.

최신 배포: 앱 소스 `b9ca5a7`, Hosting version `41924ba6520e3300`, 만료 2026-11-02 21:03:56 (Asia/Seoul).

실제 클라우드 검증:

- 공개 `/signup`에서 가입 요청 → `/account`에서 동일 이메일 표시 → 관리자 API로 해당 UID 하나만 조회해 서버 저장 확인.
- 공개 `/account` 새로고침 후 세션 유지 → 로그아웃 → 같은 계정으로 로그인 → 로그아웃 확인.
- 공개 로그인 화면의 데스크톱/390px 모바일 렌더와 메뉴 → `/demo` 이동·샘플 기준 변경 확인. JS/HTTP 오류 없음.
- 승인된 합성 계정 하나만 관리자 API로 삭제하고, 해당 UID 재조회에서 부재 확인. 실제 개인 계정·메일 발송은 테스트에 사용하지 않았습니다.
- 실제 관측 브라우저 요청 13건: 문서 2, 정적 리소스 6, Auth API 5. 별도 관리자 검증·정리 요청 3건으로 사용자 경로 검증 총 16건. Auth config의 읽기·설정·재조회와 Hosting 배포 트래픽은 별도 관리 작업입니다. 반복 부하 검사·크롤링은 하지 않았습니다.

이 결과는 실제 Firebase Auth 인증 경로의 검증입니다. Physical-device-verified인 실물 휴대폰 조작은 아니며, 비밀번호 재설정 메일의 실제 수신·Firestore 개인 규칙 동기화·로컬 파일 작업은 미검증입니다. 단순 화면 캡처나 Emulator 성공으로 실제 인증 성공을 대신하지 않았습니다.

폰트는 Pretendard 1.3.9(OFL-1.1), 라이선스 동봉. 기존 히어로 이미지를 그대로 사용했습니다. 새 로그인 화면은 같은 서체·색·버튼·여백 체계로 구현했습니다.

## Google 로그인과 관리자 계정 (후속 변경)

로그인·가입 화면의 `Google로 계속하기`는 `GoogleAuthProvider`와 `signInWithPopup`을 사용합니다. 기본 프로필·이메일 외 Google API 접근 범위를 추가하지 않습니다. 취소·팝업 차단·기존 로그인 방식 충돌을 한국어로 알리고, 로그인 창을 닫으면 다시 시도할 수 있습니다. Google 로고는 공식 브랜딩 자료의 원본 이미지입니다: https://developers.google.com/static/identity/images/g-logo.png

Firebase가 발급하는 ID token의 `admin === true`와 `email_verified === true`가 모두 있어야 `/admin` 화면에 접근합니다. 프런트엔드에 관리자 이메일 목록이나 비밀번호를 넣지 않습니다. 토큰 변경·로그아웃 시 기존 권한을 먼저 지우고 다시 확인합니다.

사용자 요청의 AFO 운영자 계정을 서버에 비밀번호 없이 생성하고 `admin: true` custom claim을 지정·재조회했습니다. 이메일 소유 확인은 대신 표시하지 않았으므로 최초 Google 로그인 전에는 관리자 접근이 거부됩니다. Google로 동일 이메일을 인증하면 기존 UID에 연결되고 관리자 계정으로 사용할 수 있는 구조입니다.

**관리자 기능의 범위:** 현재 `/admin`은 로그인한 운영 계정·인증된 관리자 권한과 서비스 화면 링크를 표시합니다. 회원 목록 조회·차단·삭제, 타인의 규칙 수정, 실제 파일 변경은 제공하지 않습니다. 클라이언트 route guard는 백엔드 권한 강제 장치가 아닙니다. 향후 관리 데이터나 실행 API를 만들면 서버·Security Rules에서 서명된 토큰의 관리자 claim과 이메일 본인 확인을 별도로 강제해야 합니다. 기존 Firestore 규칙·Firebase IAM 권한은 이번 변경에서 수정하지 않았습니다.

검증: 일반/Emulator 빌드 통과. 실제 Auth Emulator popup에서 취소 복귀, 일반 Google 사용자의 관리자 접근 거부, 미확인 이메일의 관리자 접근 거부, 비밀번호 없는 사전 생성 계정의 Google 연결 후 UID·claim 보존, 관리자 접근과 새로고침 유지, 모바일 넘침 없음을 확인했습니다. 이는 합성 Google identity를 쓰는 Emulator 검증이며 실제 Google OAuth 성공을 뜻하지 않습니다.

CSP는 Firebase Auth iframe origin과 `apis.google.com` helper script만 추가 허용하고, `Cross-Origin-Opener-Policy: same-origin-allow-popups`를 적용했습니다. 광범위한 wildcard·unsafe-inline·unsafe-eval은 추가하지 않았습니다. 공개 제공업체 활성화와 실제 Google 로그인 결과는 별도로 확인합니다.

최신 Google 옵션 배포: 앱 소스 `f3bca4c`, Hosting version `e2cd1509bfb765a5`, 만료 2026-11-02 21:24:39 Asia/Seoul. 공개 `/login`의 Google 버튼·모바일 렌더를 별도로 확인했습니다. 이 변경의 공개 확인은 문서 탐색 1회이며, Google 제공업체 설정의 최종 저장은 사용자 확인을 기다립니다. 관리자 계정은 서버 생성·claim 재조회까지 확인했지만, 실제 Google 본인 인증과 관리자 화면 진입은 아직 미검증입니다.


## 개인 규칙과 후속 검사 (#37)

`/rules`에서 최대 20개 규칙을 추가·수정·켜기/끄기·제거할 수 있습니다. 브라우저 저장은 로그인 UID별 보관함과 비로그인 보관함을 구분하며 자동 클라우드 업로드는 하지 않습니다. 브라우저 자료를 지우거나 다른 브라우저로 바꾸면 이 보관함은 유지되지 않습니다. JSON 내보내기/가져오기로 규칙을 옮길 수 있으며 가져오기는 64 KiB 이하만 허용합니다. 잘못된 자료·절대 경로·상위 경로·예약명은 공용 계약으로 거부하고 실패한 가져오기로 편집 내용을 덮어쓰지 않습니다.

JSON은 `RuleSetDraft` 계약이며 CLI의 `.afo-profile.json`과 다릅니다. 파일 내용·절대 경로·참고 근거·실행 승인 자료를 담지 않고 CLI 자동 적용을 제공하지 않습니다. 샘플 체험은 기존 고정 예시를 유지합니다.

클라우드 UI는 `createRuleRepository` v2를 재사용합니다. 저장 전 최신 버전을 불러오며 다른 창의 변경은 충돌로 남깁니다. 오프라인·불확실한 저장·cleanup 미완료 뒤에는 이전 요청을 재실행하지 않고 먼저 서버에서 다시 조회합니다. 편집 상태와 늦게 도착한 응답은 계정 전환 시 초기화합니다.

공개 빌드는 `VITE_AFO_CLOUD_RULES`를 설정하지 않아 클라우드를 비활성화합니다. 기존 실제 Firestore 규칙이 v1이기 때문입니다. 기존 데이터 확인/필요한 이관, 정확한 프로젝트의 v2 보안 규칙 배포 승인·readback·실제 계정의 저장/조회 검증 이후에만 `VITE_AFO_CLOUD_RULES=enabled npm run build`를 사용합니다. CSP에는 Firebase Auth·Firestore의 정확한 API 호스트만 허용합니다. 자세한 순서는 [로드맵](../../docs/WEBSITE_ROADMAP.md)에 있습니다.

```sh
npm run build
npm test
npm run build:emulator
npm run test:e2e
```

브라우저 검사는 Playwright의 별도 headless Chromium과 실제 Auth/Firestore/Hosting Emulator를 사용합니다. Browser plugin/skill이 제공되지 않아 Playwright를 사용하며 기존 사용자 탭/입력은 조작하지 않습니다. 최초 환경에는 JDK 21 이상과 `npx playwright install chromium`이 필요합니다. macOS의 Java가 PATH에 없으면 해당 명령에만 `PATH=/opt/homebrew/opt/openjdk/bin:$PATH`를 지정할 수 있습니다. 전역 설정은 바꾸지 않습니다.

Emulator 규칙은 실행 때 `firebase/firestore.rules`에서 `.emulator/firestore.rules`로 정확히 복사하며 생성본을 커밋하지 않습니다. 공개 빌드 `dist`와 Emulator 빌드 `dist-emulator`는 분리합니다. GitHub의 `Website verification`은 빌드·단위·실제 Emulator 사용자 경로를 검사합니다. Emulator 통과는 실제 클라우드나 실물 휴대폰의 검증을 대신하지 않습니다.

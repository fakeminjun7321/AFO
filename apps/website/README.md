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

**실제 파일을 읽거나 이동·삭제하지 않습니다.** 샘플은 설명용으로 미리 정한 결과입니다. 로그인해도 로컬 CLI와 개인 규칙의 Firestore 저장은 연결되지 않습니다. 공용 엔진·Firebase 연동 패키지·루트 lockfile은 수정하지 않습니다.

## 실행과 빌드

Node.js 24 환경에서 이 디렉터리 기준:

```sh
npm ci
npm run dev
npm run build
```

개발 서버는 http://127.0.0.1:15173 입니다. 일반 빌드는 등록된 `AFO Web` 앱의 실제 Firebase Auth에 연결합니다. 브라우저 식별용 공개 설정은 `src/config/firebase.public.json`이며 서비스 계정·관리자 자격 증명은 없습니다. 실제 비밀번호와 인증 토큰은 소스·로그에 저장하지 않으며 세션은 Firebase SDK가 관리합니다.

## 격리된 Auth 검증

```sh
npm run build:emulator
firebase emulators:start --only auth,hosting --project demo-afo-website --config firebase.emulator.json --non-interactive
```

http://127.0.0.1:15175 에서 확인합니다. 이 빌드는 `demo-afo-website`와 Auth Emulator 19101만 사용합니다. `emulator` 모드를 로컬 외부 주소에서 실행하면 시작을 거부합니다. Emulator 결과 디렉터리는 `dist-emulator`, 공개 배포용 디렉터리는 `dist`로 분리했습니다. Emulator에서 실제 계정·외부 메일을 사용하지 않습니다.

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

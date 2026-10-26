# AFO 읽기 전용 관리자 API

현재 상태: 구현·단위 검사·Functions/Auth/Firestore Emulator 통과. **공개 배포 차단됨: 프로젝트 billingEnabled=false이며 Cloud Functions 사용에 필요한 Blaze 전환·결제 연결 승인이 없음.** 기존 IAM·결제·Functions 공개 환경은 변경하지 않았습니다.

`adminOverview` callable은 Firebase가 검증한 request.auth의 admin=true 및 email_verified=true를 서버에서 모두 요구합니다. 미로그인401, 일반/미확인 관리자403을 실제 Emulator HTTP 호출로 확인했습니다.

응답은 한 페이지 최대50명의 UID·이메일·표시이름·가입/최근로그인 시각·제공업체·비활성/이메일확인 상태와 페이지 토큰, 이 API 인스턴스의 Node/지역/가동 시간/메모리, Firestore 읽기 probe 결과입니다. 비밀번호·hash·salt·refresh token·임의 custom claims는 allowlist mapper에서 제외합니다. 프로젝트 전체 트래픽·과금·CPU 지표라고 표현하지 않습니다. 사용자 수정/차단/삭제 API는 없습니다.

## 실행

```sh
npm ci
npm test
```

상위 website에서 build:emulator 및 test:e2e를 실행하면 Functions 15193, Auth19103, Firestore18103의 demo 프로젝트로 통합 검증합니다. 초기 실패를 숨기지 않았습니다. 브라우저 CORS 로컬 origin, 서버 준비 시점, Firestore probe의 유효한 경로를 수정한 뒤 전체 4개 시나리오가 통과했습니다. 실제 데이터가 표시된 관리자 캡처는 이 채팅의 외부 산출물 폴더에 보관했습니다.

## 승인 후 배포할 정확한 대상

- Firebase/GCP 프로젝트: afo-hackathon-2026-7321
- 코드베이스: afo-admin, callable: adminOverview, 지역: asia-northeast3
- 런타임: Node24, 메모리256MiB, minInstances0, maxInstances1, concurrency1, timeout20s
- 전용 런타임 서비스 계정: afo-admin-reader@afo-hackathon-2026-7321.iam.gserviceaccount.com
- 필요한 읽기 전용 역할: roles/firebaseauth.viewer, roles/datastore.viewer. Owner/Editor/사용자수정·삭제 권한은 요구하지 않음.
- 키 파일을 만들거나 브라우저에 넣지 않음. Cloud runtime ADC를 사용.
- 공개 origin은 승인된 website-design preview 한 개. localhost origin은 Emulator에서만 허용.

배포 전 사용자가 결제 계정과 요금제 전환을 직접 확인·승인해야 합니다. 무료 사용량이 있어도 빌드/컨테이너 보관·사용량에 따른 과금 가능성이 있고, maxInstances=1이 비용 상한을 보장하지 않습니다. 무료 유지 대안은 현재 관리자 화면의 Firebase 콘솔 링크이며, 사이트 안의 실시간 관리자 API와 구분합니다.

승인 후에도 IAM 생성·역할 부여·Functions 배포·실제 권한 확인을 마친 뒤에만 services.public.json의 adminApi를 true로 바꿉니다. 현재 false입니다.

공식 근거:
- https://firebase.google.com/docs/projects/billing/firebase-pricing-plans
- https://firebase.google.com/docs/functions/faq-and-troubleshooting
- https://docs.cloud.google.com/iam/docs/roles-permissions/firebaseauth
- https://docs.cloud.google.com/iam/docs/roles-permissions/firestore

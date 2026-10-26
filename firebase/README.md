# AFO Firebase 연동 기반

담당: Codex, 이슈 #25. 이 디렉터리는 독립 package/lockfile을 사용합니다. Claude가 구현 중인 루트 CLI·공용 계약·실행기·CI는 변경하지 않습니다.

## 역할과 현재 상태

Firebase는 Authentication, 사용자별 분류 규칙 저장, Hosting을 담당합니다. 파일 분석·이동·삭제와 그 승인은 로컬 CLI의 공용 엔진에 남깁니다.
이 패키지는 Firebase client SDK를 사용하며 서비스 계정이나 Admin SDK를 제품 클라이언트에 넣지 않습니다. Firebase CLI는 개발 의존성일 뿐 제품의 관리자 권한이 아닙니다.

- 구현: 규칙 저장·조회·목록·수정·삭제와 버전 충돌 거부, Security Rules, Emulator 테스트, Hosting 설정
- Emulator 검증: 실제 Auth 익명 로그인과 Firestore 데이터/권한 요청. 목업 서버가 아닙니다.
- 실제 Firebase 프로젝트: `afo-hackathon-2026-7321`
- [Hosting 연결 확인 미리보기](https://afo-hackathon-2026-7321--setup-0seg40g2.web.app)
- [Firebase 콘솔](https://console.firebase.google.com/project/afo-hackathon-2026-7321/overview)

미리보기는 2026-11-02까지 유효한 연결 확인용 페이지입니다. 실제 클라우드 Authentication 제공자·Firestore DB·CLI 계정 연결과 사용자용 GUI는 아직 연동/검증하지 않았습니다. 다운로드/설정 페이지만으로 대회 URL 직접 실행 조건을 충족했다고 보고하지 않습니다.
실제 결제 계정 연결, 유료 서비스 활성화, 운영 Hosting 채널 배포는 수행하지 않았습니다. Hosting 미리보기의 Auth 허용 도메인 자동 등록도 하지 않았습니다.

## 데이터와 권한

```text
users/{uid}/ruleSets/{setId}
  formatVersion: 2, name, revision, ruleIds, deleted, updatedAt
users/{uid}/ruleSets/{setId}/rules/{revision}_{ruleId}
  id, extension, keyword, targetDirectory, enabled, revision, updatedAt
```

각 사용자는 자기 UID 아래의 문서만 읽고 쓸 수 있습니다. 저장은 메타데이터와 규칙 문서를 같은 Firestore transaction에서 갱신하며 기준 revision이 달라지면 덮어쓰지 않습니다.
한 묶음은 규칙 최대 20개로 제한합니다. 규칙 하나를 문서 하나로 분리하여 Security Rules의 평가 한도를 피하고, 최대 20개 저장과 축소 갱신을 실제 Emulator로 검사합니다.
원본 파일 내용·절대 경로·참고 파일명·실행 승인 토큰은 데이터 필드가 아닙니다. 기존 로컬 Profile JSON을 그대로 저장하면 strict 스키마가 거부합니다.
클라우드 규칙을 로컬에 가져올 때도 로컬 계약으로 다시 검증하고 사용자 확인을 받아야 합니다. 클라우드 데이터·로그인은 로컬 파일 변경 승인이 아닙니다.

각 세대의 규칙 문서는 생성 후 수정할 수 없습니다. 부모를 저장할 때 Security Rules가 참조하는 최대 20개 문서가 모두 있는지 확인하고 현재 세대의 삭제도 막습니다. 부모는 삭제 대신 `deleted: true`, 빈 ruleIds와 고정 이름 `deleted`를 가진 tombstone으로 바뀌어 버전이 계속 증가합니다. 같은 ID로 다시 만들 때도 과거 버전의 저장·삭제 요청은 거부합니다.

공개용 RuleSetDraft/StoredRuleSet 포맷은 v1을 유지하지만 Firestore 저장 포맷은 v2입니다. 기존 v1 저장 문서는 자동 변환하거나 덮어쓰지 않고 오류를 반환합니다. 실제 클라우드 DB는 아직 구성하지 않았으며, 기존 개발 자료가 있다면 내보낸 후 별도로 마이그레이션해야 합니다.

새 세대 공개는 transaction 하나로 처리하고, 이전 세대 삭제는 20개 이하 배치로 뒤이어 수행합니다. 후속 정리만 실패하면 `CleanupPending` 오류의 `committedRevision`에 이미 저장된 버전을 돌려줍니다. 이전 버전으로 save/remove를 재시도하지 말고 다시 조회한 뒤 `repository.cleanup(id)`으로 정리를 재시도합니다. 정리가 끝날 때까지 이전 세대가 남을 수 있으며 tombstone의 버전은 유지됩니다. cleanup은 현재·새 세대 문서를 삭제할 수 없습니다.

## 로컬 실행

Node.js 24, JDK 21 이상이 필요합니다. 이 폴더에서 실행합니다.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run test:emulator
```

macOS에서 JDK가 PATH에 없으면 해당 실행에만 JAVA_HOME/PATH를 지정합니다. 전역 Java 설정을 바꿀 필요는 없습니다.
테스트 프로젝트는 `demo-afo-tests`이며 Auth 19099, Firestore 18080, Hosting 15010, hub 14410, logging 14510의 loopback 주소만 사용합니다. Emulator 환경 변수가 빠지거나 다른 프로젝트를 가리키면 시작 단계에서 실패합니다.
다운로드한 Emulator 바이너리와 설정 캐시는 `.cache/`에 보관합니다. 테스트 종료 후 해당 suite를 종료합니다.
정책 평가 한도 오류 때문에 거부된 요청을 올바른 권한 검사로 오인하지 않도록 테스트 실행기가 한도 오류를 발견하면 실패합니다.

## CLI와 후속 GUI의 연결 지점

```ts
import { createRuleRepository } from '@afo/firebase-foundation';
const repository = createRuleRepository(auth, firestore);
const revision = await repository.save('school', portableRuleSet, null);
const stored = await repository.read('school');
await repository.save('school', editedPortableRuleSet, revision);
```

`auth`와 `firestore`는 같은 Firebase app의 사용자용 client SDK 객체입니다. 실제 로그인 제공자와 자격 증명 저장·갱신은 아직 CLI에 연결하지 않았습니다.
지금은 루트 프로젝트의 dependency나 명령을 추가하지 않았습니다. 공용 계약과 root lockfile 담당자와 합의한 뒤 adapter/선택 명령으로 연결해야 합니다. GUI도 같은 repository를 사용할 수 있습니다.

## 검증 범위

단위 검사는 portable 스키마·경로·원본 프로필 유입·필드·ID를 확인합니다. Emulator 검사는 로그인, 소유자 CRUD, stale revision, 미인증/교차 사용자 접근, raw SDK의 정책 우회, 최대 크기, Hosting 응답을 확인합니다.
Emulator 통과는 실제 프로젝트의 Auth·Firestore 연동 또는 CLI 전체 사용자 경로 검증을 대신하지 않습니다. 공개 Hosting의 HTTP 응답 확인도 로그인·동기화 증거가 아닙니다.

공식 근거: [사용자 클라이언트와 Admin SDK 구분](https://firebase.google.com/docs/admin/setup), [Emulator 구성](https://firebase.google.com/docs/emulator-suite/install_and_configure), [Firestore transaction](https://firebase.google.com/docs/firestore/manage-data/transactions).

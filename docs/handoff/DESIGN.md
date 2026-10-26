# AFO 쓰기 경로 목표 설계 (coordinator 작성, 2026-10-26)

모든 builder는 이 설계에 맞춥니다. 세부 구현은 담당자가 정하되, 바꾸려면 반환 보고에 이유를 적습니다.
기존 읽기 전용 계약(`RootSchema`, `FileSchema`, `ScanSchema`, `ProfileSchema` v1, `PreviewSchema`)과 CLI `preview/suggest-rules/confirm-rules`는 깨지지 않게 유지합니다.

## 모듈

| 경로 | 내용 |
| --- | --- |
| `packages/contracts/src/index.ts` | 모든 런타임 스키마·타입·`ErrorCode`. 파일 I/O 없음 |
| `packages/engine/src/` | 순수 함수: 분류, 중복, 개인 규칙 적용, 계획 생성(`buildPlan`), plan hash, 승인 코드 계산 |
| `packages/filesystem/src/index.ts` | 기존 스캔·해시 |
| `packages/filesystem/src/platform.ts` | OS 어댑터: no-clobber 이동, 휴지통, 영구 삭제, 여유 공간, 볼륨 확인 (#3) |
| `packages/filesystem/src/state.ts` | 앱 로컬 상태 폴더, 원자적 JSON 쓰기, 잠금 (#4/#13) |
| `packages/filesystem/src/profiles.ts` | 개인 규칙 프로필 저장소 (#18) |
| `packages/filesystem/src/service.ts` | 공용 실행 서비스: RootGrant 발급, plan 저장, 승인 발급·소비, 실행, 저널, 되돌리기, 복구 (#8/#10–#13) |
| `apps/cli/src/index.ts` | 인수·TTY 확인·출력만. 서비스 호출 |

## 상태 폴더

- `AFO_STATE_DIR` 환경변수가 있으면 그 경로, 없으면 macOS `~/Library/Application Support/AFO`, Windows `%LOCALAPPDATA%\AFO`, 기타 `$XDG_STATE_HOME/afo` 또는 `~/.local/state/afo`.
- 작업 루트 안이거나 루트를 포함하는 상태 폴더는 거부(`STATE_DIR_CONFLICT`).
- 하위: `profiles/`, `plans/`, `approvals/`, `journal/<runId>.jsonl`, `locks/<rootId>.lock`.
- JSON 쓰기: 같은 폴더 temp 파일 → fsync → rename → 부모 fsync(가능한 OS). JSONL 저널: append + fsync per entry.

## ErrorCode (contracts)

`ROOT_FORBIDDEN, PATH_OUTSIDE_ROOT, LINK_REJECTED, FILE_CHANGED, SOURCE_MISSING, DEST_EXISTS, CROSS_VOLUME,
NOT_SUPPORTED, PERMISSION_DENIED, LOCKED_BY_OTHER, FILE_BUSY, APPROVAL_MISSING, APPROVAL_INVALID, APPROVAL_EXPIRED,
APPROVAL_USED, PLAN_CHANGED, PROFILE_CHANGED, MODE_MISMATCH, KEEPER_INVALID, JOURNAL_FAILED, TRASH_FAILED,
STATE_DIR_CONFLICT, DISK_FULL, CANCELLED, UNKNOWN`
`AfoError extends Error { code: ErrorCode }` 는 contracts 또는 filesystem 공용 모듈에 둡니다.

## 계약 객체 (모두 `formatVersion: 1`, strict, 누락·자료형 오류는 실패)

- `RootGrant`: `id`(sha256 hex), `canonicalPath`, `device`, `inode`, `scope: 'work'`, `sessionId`, `issuedAt`(ISO).
- `ReferenceGrant`: 같은 필드 + `scope: 'reference'`, `readOnly: true`. 쓰기 API는 `scope:'work'`만 받음.
- `FileSnapshot`: 기존 `FileSchema` 그대로.
- `PlanOperation`: `id`(plan 안에서 유일, 짧은 hex), `kind: 'move'|'trash'|'delete'`, `fileId`, `source`, `destination`(move만, 나머지 null),
  `reason`, `ruleId|null`, `keeper|null`(중복 삭제 시 남길 파일 상대 경로), `expected: {size, modifiedNs, device, inode, sha256|null}`.
- `OperationPlan`: `id`(=planHash), `rootGrantId`, `rootPath`, `sessionId`, `createdAt`, `expiresAt`, `profileId|null`, `profileRevision|null`,
  `deleteMode: 'trash'|'permanent'`, `operations[]`, `reviewItems[]`(실행 안 하는 검토/유지 항목과 이유), `summary{move, trash, delete, logicalBytes}`.
  planHash = 정렬된 canonical JSON(`id` 제외)의 sha256.
- `Approval`: `id`, `planId`, `sessionId`, `rootGrantId`, `operationIds[]`(정렬, 1개 이상, plan 부분집합), `mode: 'organize'|'trash'|'permanent-delete'`,
  `profileRevision|null`, `issuedAt`, `expiresAt`(발급 +10분), `usedAt|null`. 서비스만 발급·저장·소비. CLI 인수/JSON의 불리언으로 생성 불가.
  - 승인 코드: `sha256(planId + sortedOpIds + mode).slice(0, 8)` 를 사용자가 직접 확인 입력. 영구 삭제는 추가로 정확한 문구 `영구 삭제` 입력.
  - 한 승인 = 한 모드. organize(move만), trash(trash만), permanent-delete(delete만). 섞인 선택은 `MODE_MISMATCH`.
- `JournalEntry`: `runId`, `seq`, `opId`, `approvalId`, `phase: 'intent'|'done'|'failed'|'skipped'|'undo-intent'|'undone'`, `kind`, `source`, `destination|null`,
  `before{device,inode,size,sha256|null}`, `after|null`, `errorCode|null`, `at`.
- `ExecutionReport`: `runId`, `planId`, `approvalId`, `results[{opId, status: 'moved'|'trashed'|'deleted'|'skipped'|'failed'|'unknown', errorCode|null, detail}]`,
  `space{logicalBytesSelected, freeBytesBefore|null, freeBytesAfter|null, note}`. 휴지통은 확보량으로 세지 않음.

## 실행 규칙 (#10–#13)

1. 루트 잠금 획득(`open(..., 'wx')`, 내용 pid·시작 시각). 살아있지 않은 pid의 잠금만 stale로 해제.
2. 승인 검증: 존재, 미사용, 미만료, planId·rootGrantId·sessionId·profileRevision 일치, plan 파일 hash 재계산 일치, 선택 op가 plan 부분집합, mode 일치. 승인을 먼저 `usedAt` 기록(재사용 방지) 후 실행.
3. 각 op: 저널 `intent` fsync → 원본 재검증(lstat dev/ino/size/mtime, nlink 1, 링크 아님, realpath가 루트 안, 부모 경로에 링크 없음, expected.sha256 있으면 재해시) → 작업 → 결과 독립 확인 → 저널 `done`/`failed`.
4. 이동: 목적지 부모 폴더를 루트 안에서만 하나씩 생성(링크 거부) → `fs.link(src, dst)`(EEXIST → `DEST_EXISTS`, EXDEV → `CROSS_VOLUME`, 지원 안 함 → `NOT_SUPPORTED`) → dst의 dev/ino가 src와 같음 확인 → `fs.unlink(src)` → src 부재 확인. 덮어쓰기 없음.
5. 휴지통: macOS `/usr/bin/trash <abs>`(execFile, shell 없음), Windows PowerShell `Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(path,'OnlyErrorDialogs','SendToRecycleBin')`(경로는 인수/환경변수로 전달, 문자열 조립 금지). 결과 후 원래 경로 부재 확인. 실패 시 영구 삭제로 우회 금지.
6. 영구 삭제: 남길 파일(keeper)이 존재하고 같은 sha256인지 실행 직전 확인 → `fs.unlink` → 부재 확인. `fs.statfs`로 전후 여유 공간 관측(다른 프로세스 영향 가능 표기).
7. 중단 복구: 저널에 `intent`만 있고 `done/failed`가 없는 op는 실제 파일 상태와 대조해 `unknown`으로 보고. 자동 재실행·원복·삭제 없음. 성공한 op는 재실행하지 않음.
8. 되돌리기(`undo <runId>`): `moved` op만, 목적지 파일이 같은 dev/ino/size/sha256이고 원래 경로가 비어 있을 때만 같은 no-clobber 방식으로 역이동.

## CLI 목표 (interface-builder)

- 유지: `preview`, `suggest-rules`, `confirm-rules`.
- `rules list|save <profile.json>|disable <id>|enable <id>|reset|correct <파일 경로> <목적지> [--remember]` (#18; `--remember` 없으면 이번 계획에만 적용).
- `plan <루트> [--profile <id>] [--reference <폴더>] [--delete-mode trash|permanent] [--json]` → 계획 저장, plan ID·요약·작업 ID·모드별 승인 코드 출력.
- `apply <planId> --mode organize|trash|permanent-delete [--only <opId,...>] [--confirm <승인코드>]` → TTY면 요약 표시 후 코드(영구 삭제는 문구도) 입력, 비TTY면 `--confirm` 없을 때 거부. 결과 보고 출력.
- `undo <runId> [--confirm <코드>]`, `runs`, `recover`.
- 종료 코드: 0 성공, 1 오류, 2 사용법 오류, 3 일부 실패/unknown, 4 승인 거부/무효, 130 취소. `--json`은 stdout에 JSON만.

## 세션 간 인터페이스 (2026-10-26 3개 세션 분할 후 고정)

세 세션이 동시에 작업하므로 아래 시그니처는 coordinator 동의 없이 바꾸지 않습니다. 바꿔야 하면 PR 설명과 coordinator 보고에 적습니다.

```ts
// packages/filesystem/src/approvals.ts — 세션 A(coordinator) 소유, #8
export interface ApprovedBatch {
  plan: OperationPlan; approval: Approval;          // 검증·소비(usedAt 기록) 완료된 승인
  operations: PlanOperation[];                       // approval.operationIds 순서대로, plan의 부분집합
  grant: RootGrant;                                  // 이 프로세스에서 재발급·plan.rootPath/dev/inode와 대조 완료
  stateDir: string;                                  // resolveStateDir 결과, 루트 밖 확인 완료
}
export function consumeApproval(stateDir: string, approvalId: string, now?: Date): Promise<ApprovedBatch>;

// packages/filesystem/src/lock.ts — 세션 C 소유, #13 (가장 먼저 PR)
export function withRootLock<T>(stateDir: string, root: { canonicalPath: string; device: string; inode: string }, fn: () => Promise<T>): Promise<T>;
// 2026-10-26 변경(세션 B 발견): grant.id는 발급마다 salt가 달라 프로세스 간 잠금 키로 못 씀 → 키 = sha256(device+inode). 다른 실행 중이면 AfoError LOCKED_BY_OTHER

// packages/filesystem/src/executor.ts — 세션 B 소유, #10–#12
export function executeBatch(batch: ApprovedBatch, options?: { signal?: AbortSignal; onProgress?: (p: { done: number; total: number }) => void;
  faultInjection?: (point: 'after-intent' | 'after-op' | 'before-done', opId: string) => void /* 테스트 전용, #13 */ }): Promise<ExecutionReport>;
export function undoRun(stateDir: string, runId: string, grant: RootGrant, options?: { signal?: AbortSignal }): Promise<ExecutionReport>;
// 저널: journalFile(stateDir, runId), appendJournal — state.ts 재사용. runId = 소문자 hex/uuid.

// packages/filesystem/src/recovery.ts — 세션 C 소유, #13
export function inspectRuns(stateDir: string): Promise<Array<{ runId: string; planId: string; unfinished: Array<{ opId: string; state: 'not-started'|'linked-both'|'moved'|'missing'|'conflict'|'unknown'; action: string }> }>>;
```

테스트는 `ApprovedBatch`를 직접 만들 수 있습니다(테스트 전용 helper, `tests/` 아래). 실제 CLI 경로는 `consumeApproval` 결과만 사용합니다.

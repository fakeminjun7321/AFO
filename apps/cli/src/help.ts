import { AFO_VERSION } from './version.js';

/**
 * `afo help` (everyday commands) and `afo help --all` (every command and option). Plain text only: no colors, so pipes,
 * Windows consoles and tests see the same output. Columns are padded by terminal width (Hangul and other wide characters
 * take two cells), so the descriptions line up in a monospace terminal.
 */
const wide = (cp: number): boolean => (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6);
const cells = (s: string): number => [...s].reduce((n, ch) => n + (wide(ch.codePointAt(0)!) ? 2 : 1), 0);

type Row = readonly [left: string, right: string];
/** Left column padded to `width` cells; a left side that does not fit puts its description on the next line. */
const table = (rows: readonly Row[], width: number, indent = '  '): string[] => rows.flatMap(([left, right]) => {
  if (!right) return [`${indent}${left}`];
  if (cells(left) + 2 > width) return [`${indent}${left}`, `${indent}${' '.repeat(width)}${right}`];
  return [`${indent}${left}${' '.repeat(width - cells(left))}${right}`];
});
const section = (title: string, lines: string[]): string[] => ['', title, ...lines];
const notes = (items: readonly string[]): string[] => items.map((item) => `  · ${item.replace(/\n/gu, '\n    ')}`);

const basicRows: Row[] = [
  ['afo', '안내를 따라 폴더 정리하기 (처음이라면 이것만 기억하세요)'],
  ['afo <폴더>', '그 폴더로 바로 시작 (지난번 폴더는 afo 뒤 Enter만)'],
  ['afo gui', '브라우저 화면에서 보고 버튼으로 정리·되돌리기'],
  ['afo undo', '가장 최근 정리를 원래대로 되돌리기'],
  ['afo runs', '지금까지 정리한 기록 보기'],
  ['afo help --all', '모든 세부 명령과 옵션 보기'],
  ['afo --version', '설치된 버전 보기'],
  ['afo update', '최신 정식 버전으로 업데이트'],
];

const basic = [
  `AFO 파일 정리 도우미 v${AFO_VERSION}`,
  ...section('자주 쓰는 명령', table(basicRows, 18)),
  ...section('afo로 정리하는 순서', ['  폴더를 끌어다 놓기 → 정리 후 모습 보기 → 정리 방법 고르기 → y로 확인 → 정리']),
  ...section('안심하고 쓰세요', notes([
    '무엇을 할지 먼저 보여 주고, 확인해야만 파일을 옮깁니다.',
    '정리(되돌릴 수 있음)는 Enter·y, 휴지통 보내기는 y를 직접 입력해야 실행합니다.',
    '영구 삭제는 메뉴에 없습니다. (afo help --all의 plan·apply 참고)',
    '정리는 afo undo로 되돌리고, 휴지통으로 보낸 파일은 OS 휴지통에서 복원합니다.',
    '터미널이 아니면(파이프·스크립트) afo <폴더>는 preview <폴더>와 같고, 파일을 바꾸지 않습니다.',
  ])),
  ...section('Finder·탐색기에서', ['  폴더 오른쪽 클릭 → macOS 빠른 동작 / Windows 보내기 → \'AFO로 정리\' (afo gui와 같은 화면)']),
].join('\n');

const W = 34; // option/command column of the full help
const all = [
  `AFO 파일 정리 도우미 v${AFO_VERSION} — 전체 도움말`,
  ...section('자주 쓰는 명령', table(basicRows, 18)),

  ...section('미리보기 · 정리 계획  (사용자 파일을 바꾸지 않음)', [
    ...table([['preview <폴더>', '정리안 미리보기 (저장된 개인 규칙을 자동 적용)']], W),
    ...table([
      ['--reference <참고 폴더>', '참고 폴더의 정리 방식으로 규칙 후보 보기'],
      ['--profile <JSON>', '저장된 규칙 대신 이 규칙 파일 사용'],
      ['--no-saved-rules', '저장된 개인 규칙 없이 기본 규칙만'],
      ['--move <상대 경로>=<폴더>', '이번만 목적지 바꾸기 (여러 번 가능)'],
      ['--remember', '--move 수정을 이후에도 적용하도록 저장'],
      ['--json', 'JSON으로 출력'],
    ], W - 2, '    '),
    '',
    ...table([['plan <폴더>', '계획을 저장하고 작업 ID·이유·방식별 승인 코드 출력']], W),
    '    preview의 옵션(--remember 제외)과 함께:',
    ...table([
      ['--delete-mode trash|permanent', '삭제 방식 (기본 trash=휴지통, permanent는 되돌릴 수 없음)'],
      ['--delete-duplicates all|<해시,...>', '중복 사본을 삭제 후보로 (그룹 해시 앞 8자 이상)'],
      ['--delete-file <상대 경로>', '이 파일을 삭제 후보로 (여러 번 가능)'],
      ['--delete-last-copy', '같은 내용의 마지막 사본까지 지우기 허용'],
      ['--json', 'JSON으로 출력'],
    ], W - 2, '    '),
  ]),

  ...section('실행 · 되돌리기  (확인 코드를 입력해야 파일을 바꿈)', [
    ...table([['apply <계획 ID> --mode <방식>', '저장된 계획의 한 방식 작업을 확인 후 실행']], W),
    ...table([
      ['--mode organize|trash|permanent-delete', ''],
      ['', '정리(이동) · 휴지통 · 영구 삭제 중 하나'],
      ['--only <작업ID,...>', '고른 작업만 실행'],
      ['--confirm <승인 코드>', 'plan이 알려 준 승인 코드 (터미널이 아니면 필수)'],
      ['--phrase <확인 문구>', '영구 삭제에 필요한 문구 "영구 삭제"'],
      ['--json', 'JSON으로 출력'],
    ], W - 2, '    '),
    '',
    ...table([
      ['undo [<실행 ID>]', '정리(organize) 실행을 원래 위치로 (ID를 빼면 가장 최근)'],
      ['  --confirm <실행 ID 앞 8자>', '터미널이 아닐 때 확인 코드'],
      ['runs [<실행 ID>]', '실행 기록 요약, 또는 한 실행의 항목별 결과'],
      ['recover', '끝나지 않은 실행·결과 불명 항목 보고 (자동 재실행·원복·삭제 없음)'],
    ], W),
    '    undo·runs·recover 모두 --json을 쓸 수 있습니다.',
  ]),

  ...section('브라우저 화면', [
    ...table([['gui [<폴더>]', '이 컴퓨터에서만 열리는 화면으로 미리보기·계획·규칙·기록 보기,']], W),
    `  ${' '.repeat(W)}목록 확인 후 정리·중복 휴지통 보내기·되돌리기 (Ctrl+C로 종료)`,
    ...table([
      ['--port <번호>', '포트 지정 (1024–65535, 생략하면 빈 포트)'],
      ['--no-open', '브라우저를 자동으로 열지 않기'],
      ['--exit-when-closed', '화면을 닫으면 잠시 뒤 저절로 종료'],
    ], W - 2, '    '),
  ]),

  ...section('개인 정리 규칙', table([
    ['suggest-rules <참고 폴더>', '규칙 후보(초안) JSON은 stdout, 요약은 stderr로'],
    ['rules save <초안 JSON> --select <ID,...>', ''],
    ['', '고른 규칙만 저장'],
    ['rules list', '저장된 규칙과 수정 보기'],
    ['rules enable|disable <규칙ID>', '규칙 하나 켜기·끄기'],
    ['rules enable-all|disable-all', '저장된 규칙 전체 켜기·끄기'],
    ['rules forget <수정ID>', '--remember로 저장한 수정 지우기'],
    ['rules reset [--confirm reset]', '저장된 규칙 초기화'],
    ['confirm-rules <JSON> --select <ID,...>', ''],
    ['', '(이전 방식) 확인한 규칙 JSON만 출력'],
  ], W).concat(['    suggest-rules·rules list는 --json을 쓸 수 있습니다.'])),

  ...section('안전 규칙', notes([
    'preview·plan·suggest-rules·rules·runs·recover는 사용자 파일을 바꾸지 않습니다.',
    '사용자 파일을 옮기거나 지우는 명령은 apply와 undo뿐이며, 둘 다 확인 코드를 직접 입력해야 합니다.\n(터미널이 아니면 --confirm 필수, 없으면 종료 코드 4)',
    'gui 화면은 목록을 보여 주고 확인 버튼을 눌러야 같은 apply·undo 경로로 실행합니다. (영구 삭제 제외)',
    'apply는 승인 한 번에 한 번만 실행하고, 실행 직전 파일을 다시 확인해 바뀐 파일은 건너뜁니다. 덮어쓰지 않습니다.',
    '--delete-file로 같은 내용의 사본을 모두 고르면 거부합니다. (마지막 사본까지는 --delete-last-copy)',
    '휴지통으로 보낸 파일은 OS 휴지통에서 직접 복원하고, 영구 삭제는 되돌릴 수 없습니다.',
  ])),

  ...section('설치 · 상태 폴더', [
    '  afo update: 최신 정식 릴리스 확인 → SHA-256·실행 확인 → 실행 파일만 교체합니다.',
    '  이미 최신이면 유지합니다. 소스 실행본은 git pull 후 의존성 설치·빌드가 필요합니다.',
    ...table([
      ['macOS', 'curl -fsSL https://raw.githubusercontent.com/fakeminjun7321/AFO/main/install.sh | sh'],
      ['Windows', 'irm https://raw.githubusercontent.com/fakeminjun7321/AFO/main/install.ps1 | iex'],
    ], 10),
    '  규칙·계획·승인·실행 기록은 앱 로컬 상태 폴더(AFO_STATE_DIR)에 저장합니다.',
  ]),

  ...section('종료 코드', ['  0 성공 · 1 오류 · 2 사용법 오류 · 3 일부 실패·결과 불명 · 4 승인 거부·무효 · 130 취소']),
].join('\n');

export const helpText = (full: boolean): string => full ? all : basic;

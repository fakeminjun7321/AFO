import { doc, issue, pr } from "./project";

export type NoteLink = { label: string; href: string };
export type Note = { date: string; title: string; body: string; links: NoteLink[] };

/** Development log, newest first. Dates are KST merge dates of the linked PRs. */
export const notes: Note[] = [
  {
    date: "2026.11.02",
    title: "설치한 터미널에서 바로 afo",
    body: "curl로 설치한 바로 그 터미널에서 afo가 \"command not found\"로 실패하던 문제를 고쳤습니다. 이미 PATH에 있는 폴더에 링크를 두고, 다른 프로그램의 afo는 건드리지 않습니다. 공개 v0.1.0 릴리스에서 내려받아 같은 셸에서 실행되는 것을 실제 Mac에서 확인했습니다.",
    links: [{ label: "PR #56", href: pr(56) }],
  },
  {
    date: "2026.11.02",
    title: "한 줄 설치와 v0.1.0 릴리스",
    body: "Node.js 없이 실행되는 단일 실행 파일(macOS arm64·x64, Windows x64)을 만들고, curl·PowerShell 한 줄로 설치하게 했습니다. 설치 스크립트는 SHA256SUMS와 대조해 다르면 설치하지 않습니다. 같은 날 저장소를 공개하고 Apache-2.0 라이선스를 붙였습니다. 실행 파일은 코드 서명·공증을 받지 않았습니다.",
    links: [
      { label: "PR #55", href: pr(55) },
      { label: "설치 검증 기록", href: doc("docs/verification/ISSUE_15_INSTALL.md") },
    ],
  },
  {
    date: "2026.10.30",
    title: "더 넓은 분류표와 모르는 파일 묻기",
    body: "기본 분류에 디자인·글꼴·전자책·코드·데이터를 더했습니다(default-3). 그래도 종류를 모르는 파일은 대화형 정리에서 '기타'로 옮길지, 확장자마다 폴더를 정할지, 그대로 둘지 묻습니다. 다운로드 중일 수 있는 .part·.crdownload 파일은 그대로 둡니다.",
    links: [
      { label: "PR #54", href: pr(54) },
      { label: "검증 기록", href: doc("docs/verification/UNKNOWN_FILES.md") },
    ],
  },
  {
    date: "2026.10.30",
    title: "afo 한 단어로 시작하는 안내형 CLI",
    body: "\"명령어가 너무 복잡하다\"는 피드백으로 입구를 바꿨습니다. afo를 입력하고 폴더를 끌어다 놓으면 요약과 번호 메뉴가 나오고, 화면의 확인 코드를 입력해야 실행합니다. afo undo는 가장 최근 정리를 보여 주고 되돌립니다. 실제 의사 터미널(pty)로 독립 검증했습니다.",
    links: [
      { label: "PR #53", href: pr(53) },
      { label: "검증 기록", href: doc("docs/verification/CLI_GUIDED.md") },
    ],
  },
  {
    date: "2026.10.28",
    title: "실제 이동·휴지통·영구 삭제·되돌리기",
    body: "승인한 작업만 실행하는 실행기를 넣었습니다. 각 작업 전에 저널을 먼저 쓰고, 실행 직전에 파일을 다시 확인해 그사이 바뀐 파일은 건너뜁니다. 이동은 덮어쓰지 않고 되돌릴 수 있으며, 휴지통은 OS 휴지통을, 영구 삭제는 별도 방식과 확인 문구를 씁니다. CLI의 apply·undo·runs·recover로 연결했고, macOS 실제 사용자 경로 15개 시나리오를 독립 검증했습니다.",
    links: [
      { label: "PR #50", href: pr(50) },
      { label: "PR #48", href: pr(48) },
      { label: "macOS 검증 기록", href: doc("docs/verification/ISSUE_14_MACOS.md") },
    ],
  },
  {
    date: "2026.10.28",
    title: "정리 계획과 한 번의 승인",
    body: "미리보기에서 결정적인 정리 계획을 만들고, 그 계획·작업 목록·방식에 한 번만 쓸 수 있는 승인 코드를 붙였습니다. 승인 없음·위조·만료·재사용·계획 변조를 거부하는지 독립 검증했습니다.",
    links: [
      { label: "PR #49", href: pr(49) },
      { label: "검증 기록", href: doc("docs/verification/ISSUE_8.md") },
    ],
  },
  {
    date: "2026.10.28",
    title: "내 정리 방식을 기억하는 개인 규칙",
    body: "기존에 정리해 둔 폴더의 이름·확장자에서 규칙을 제안받고, 확인한 규칙만 저장해 다음 정리에 다시 씁니다. 규칙 켜기·끄기·초기화를 지원하고, 참고한 폴더의 파일은 옮기지 않습니다.",
    links: [
      { label: "PR #47", href: pr(47) },
      { label: "검증 기록", href: doc("docs/verification/ISSUE_18.md") },
    ],
  },
  {
    date: "2026.10.26",
    title: "웹 규칙 편집·로그인·테스트 자료",
    body: "웹에 규칙 편집·브라우저 보관·JSON 교환과 계정별 클라우드 저장, 합성 테스트 파일 내려받기를 추가했습니다. 웹 규칙은 CLI와 자동으로 연결되지 않습니다.",
    links: [{ label: "클라우드 규칙 검증", href: doc("docs/verification/CLOUD_RULES_V2.md") }],
  },
  {
    date: "2026.10.26",
    title: "첫 엔진: 읽기만 하는 분석",
    body: "선택한 폴더를 읽어 확장자 분류, 내용 해시(SHA-256) 중복 후보, 개인 규칙 적용 미리보기를 보여 주는 첫 CLI를 만들었습니다. 이때는 파일을 옮기거나 지우지 않았습니다.",
    links: [
      { label: "PR #20", href: pr(20) },
      { label: "검증 기록", href: doc("docs/verification/READ_ONLY_ENGINE.md") },
    ],
  },
];

export type StatusRow = { feature: string; mac: string; windows: string };
/** Mirrors the README status table and issue #1 "현재 상태 (2026-11-02)". */
export const statusRows: StatusRow[] = [
  { feature: "폴더 스캔·제외 규칙", mac: "실제 Mac 검증", windows: "CI VM만" },
  { feature: "종류별 분류·내용 해시 중복 찾기", mac: "실제 Mac 검증", windows: "CI VM만" },
  { feature: "개인 규칙 제안·저장·재사용", mac: "실제 Mac 검증", windows: "CI VM만" },
  { feature: "정리 계획·확인 코드 승인", mac: "실제 Mac 검증", windows: "CI VM만" },
  { feature: "폴더 정리·되돌리기, 휴지통, 선택 영구 삭제", mac: "실제 Mac 검증", windows: "CI VM만" },
  { feature: "중단 복구 보고·동시 실행 잠금", mac: "실제 Mac 검증", windows: "CI VM만" },
  { feature: "curl / PowerShell 한 줄 설치", mac: "실제 Mac 설치·실행", windows: "릴리스 CI에서 설치 확인" },
  { feature: "로컬 GUI (afo gui)", mac: "개발 중", windows: "개발 중" },
];

export const remaining: NoteLink[] = [
  { label: "Windows 실제 PC에서 설치·정리·되돌리기 검증", href: issue(14) },
  { label: "출품 방식(설치형 CLI·URL 인정 여부) 확인", href: issue(2) },
  { label: "외부 사용자 테스트·5분 소개 영상·최종 제출", href: issue(16) },
  { label: "CLI에서 여는 로컬 GUI(보기 전용) 마무리", href: pr(51) },
  { label: "실행 파일 코드 서명·공증(현재 미적용)", href: issue(15) },
];

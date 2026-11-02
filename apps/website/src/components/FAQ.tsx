const questions = [
  {
    question: "설치하려면 무엇이 필요한가요?",
    answer:
      "macOS(Apple Silicon·Intel) 또는 Windows 10/11(x64)만 있으면 됩니다. 설치 명령 한 줄이 내 OS용 실행 파일 하나를 받아 SHA256SUMS와 대조한 뒤 설치하며, Node.js 같은 다른 프로그램은 필요 없습니다. 로그인이나 계정도 필요 없어요.",
  },
  {
    question: "파일이 바로 옮겨지거나 삭제되나요?",
    answer:
      "아니요. afo는 먼저 요약과 작업 목록을 보여 주고, 화면에 나온 확인 코드를 직접 입력해야 실행합니다. 삭제 후보는 내용이 같은 사본뿐이고 기본적으로 OS 휴지통으로 보냅니다. 영구 삭제는 따로 선택하고 \"영구 삭제\"를 입력해야 하며 되돌릴 수 없습니다.",
  },
  {
    question: "정리한 걸 되돌릴 수 있나요?",
    answer:
      "폴더별 정리는 afo undo로 가장 최근 정리를 되돌립니다. 원래 자리가 비어 있고 옮긴 파일의 내용이 그대로일 때만 되돌리며, 그 정리가 새로 만든 빈 폴더도 정리합니다. 휴지통으로 보낸 파일은 OS 휴지통에서 꺼내면 됩니다.",
  },
  {
    question: "파일이 서버에 업로드되나요?",
    answer:
      "아니요. 설치한 afo는 내 컴퓨터 안에서만 처리합니다. 웹 미리보기도 파일 이름과 크기를 브라우저에서 읽고, 중복 검사를 고르면 같은 크기인 파일의 내용을 이 기기에서 비교합니다. 파일 내용은 서버로 보내지 않습니다.",
  },
  {
    question: "Windows에서도 확인했나요?",
    answer:
      "Windows용 실행 파일과 설치 스크립트를 제공하지만, Windows 실제 PC에서의 검증은 아직 하지 않았습니다. GitHub Actions의 Windows VM에서 자동 테스트와 설치 확인만 했어요. 실행 파일은 코드 서명이 없어 SmartScreen이나 백신 경고가 나올 수 있습니다.",
  },
  {
    question: "웹에서 실제 파일을 정리할 수 있나요?",
    answer:
      "아니요. 웹은 읽기 전용입니다. 선택한 폴더의 분류를 미리 보고, 샘플 예시와 규칙 편집·보관을 제공하지만 실제 이동·삭제는 설치한 afo에서만 합니다.",
  },
  {
    question: "저장한 규칙이 내 폴더 분석에 적용되나요?",
    answer:
      "웹 미리보기에는 현재 계정 또는 비로그인 상태의 브라우저 보관함에 저장한 활성 규칙이 적용됩니다. 클라우드에만 저장했다면 나의 규칙에서 불러온 뒤 브라우저에도 저장해 주세요. 웹 규칙은 CLI에 자동으로 적용되지 않으며, CLI의 개인 규칙은 suggest-rules·rules 명령으로 따로 저장합니다.",
  },
];
export function FAQ() {
  return (
    <section className="faq section-wrap" id="faq" aria-labelledby="faq-title">
      <h2 id="faq-title">자주 묻는 질문</h2>
      <div className="questions">
        {questions.map((item, i) => (
          <details key={item.question} open={i === 0} name="faq">
            <summary>
              {item.question}
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M3 12h18" />
                <path className="plus-vertical" d="M12 3v18" />
              </svg>
            </summary>
            <p>{item.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

const questions = [
  {
    question: "웹에서 실제 파일을 정리할 수 있나요?",
    answer:
      "웹에서 직접 폴더를 선택해 기본 분류를 미리 볼 수 있어요. 도움말의 샘플 분류 예시와 규칙 편집·보관도 제공하지만 실제 파일 이동·삭제는 아직 제공하지 않습니다.",
  },
  {
    question: "내가 만든 규칙은 어디에 저장되나요?",
    answer:
      "브라우저에 저장을 누르면 현재 브라우저에 보관됩니다. 로그인 계정별 보관함과 비로그인 보관함은 구분하며, 로그인 후 클라우드에서 불러오기·저장하기로 같은 계정의 다른 기기에서도 규칙을 사용할 수 있어요. JSON으로도 옮길 수 있습니다. JSON은 웹 규칙 교환용이며 CLI 자동 적용과는 다릅니다.",
  },
  {
    question: "파일이 서버에 업로드되나요?",
    answer:
      "기본 미리보기는 파일 이름과 크기를 읽습니다. 중복 검사를 선택하면 같은 크기인 파일의 내용을 브라우저에서 읽어 해시를 비교합니다. 파일 내용은 서버로 업로드하지 않습니다.",
  },
  {
    question: "저장한 규칙이 내 폴더 분석에 적용되나요?",
    answer:
      "현재 계정 또는 비로그인 상태의 브라우저 보관함에 저장한 활성 규칙이 적용됩니다. 클라우드에만 저장했다면 나의 규칙에서 불러온 뒤 브라우저에도 저장해 주세요. 규칙이 충돌하면 확인 대상으로 표시합니다.",
  },
  {
    question: "어떤 브라우저에서 사용할 수 있나요?",
    answer:
      "폴더 선택 기능을 지원하는 브라우저가 필요합니다. 데스크톱 Chrome 또는 Edge에서 시작해 보세요. 빈 폴더는 브라우저에서 선택되지 않을 수 있습니다.",
  },
  {
    question: "파일이 바로 삭제되나요?",
    answer:
      "아니요. 이 웹사이트에서는 파일을 이동하거나 삭제하지 않습니다. 로컬 CLI는 정리 계획을 먼저 보여 주고, 승인 코드를 입력한 항목만 실행합니다. 삭제 후보는 기본적으로 OS 휴지통으로 보내며, 영구 삭제는 따로 선택하고 확인 문구를 입력해야 하고 되돌릴 수 없습니다.",
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

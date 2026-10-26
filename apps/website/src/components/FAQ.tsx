const questions = [
  {
    question: "웹에서 실제 파일을 정리할 수 있나요?",
    answer:
      "웹에서는 샘플 체험과 분류 규칙 편집·보관을 할 수 있어요. 현재 로컬 CLI는 실제 폴더를 읽어 분류 미리보기를 만들며, 이동·삭제 명령은 아직 연결되지 않았습니다.",
  },
  {
    question: "내가 만든 규칙은 어디에 저장되나요?",
    answer:
      "브라우저에 저장을 누르면 현재 브라우저에 보관됩니다. 로그인 계정별 보관함과 비로그인 보관함은 구분하며, 로그인 후 클라우드에서 불러오기·저장하기로 같은 계정의 다른 기기에서도 규칙을 사용할 수 있어요. JSON으로도 옮길 수 있습니다. JSON은 웹 규칙 교환용이며 CLI 자동 적용과는 다릅니다.",
  },
  {
    question: "파일이 서버에 업로드되나요?",
    answer:
      "이 체험은 미리 준비한 샘플 데이터만 사용합니다. 내 컴퓨터의 파일을 읽거나 업로드하지 않아요.",
  },
  {
    question: "파일이 바로 삭제되나요?",
    answer:
      "이 웹사이트에서는 파일을 이동하거나 삭제하지 않습니다. AFO는 정리안을 먼저 확인하고, 사용자가 승인한 항목만 실행하도록 개발하고 있어요.",
  },
];
export function FAQ() {
  return (
    <section className="faq section-wrap" id="faq" aria-labelledby="faq-title">
      <h1 id="faq-title">
        궁금한 점이
        <br />
        있나요?
      </h1>
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

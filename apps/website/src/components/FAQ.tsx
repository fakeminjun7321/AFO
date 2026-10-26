const questions = [
  {
    question: "웹에서 실제 파일을 정리할 수 있나요?",
    answer:
      "지금은 샘플로 정리 흐름을 체험할 수 있어요. 실제 파일 정리는 로컬 CLI에서 진행합니다.",
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

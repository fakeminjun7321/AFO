const steps = [
  {
    title: "폴더 살펴보기",
    body: "웹에서 분석할 폴더를 직접 선택합니다. 파일 이름과 크기로 기본 분류를 보여 드려요.",
  },
  {
    title: "미리보기로 확인하기",
    body: "파일을 이동하거나 삭제하지 않고, 확장자에 따른 기본 분류를 확인합니다.",
  },
  {
    title: "나만의 기준 보관하기",
    body: "확장자와 이름을 기준으로 규칙을 만들어 브라우저에 저장하면 미리보기에 적용됩니다.",
  },
];
export function HowItWorks() {
  return (
    <section
      className="steps section-wrap"
      id="how-it-works"
      aria-label="AFO 사용 방법"
    >
      <ol>
        {steps.map((step, i) => (
          <li key={step.title}>
            <span className="step-number">0{i + 1}</span>
            <div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

const steps = [
  {
    title: "샘플 살펴보기",
    body: "체험 화면에서 준비된 파일 6개의 이름과 종류를 확인합니다.",
  },
  {
    title: "분류 미리보기",
    body: "분류 미리보기를 누르면 각 파일의 분류 위치가 표시됩니다.",
  },
  {
    title: "기준 바꿔보기",
    body: "문서 분류 기준을 과목별 정리로 바꾸고 결과를 비교해 보세요.",
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

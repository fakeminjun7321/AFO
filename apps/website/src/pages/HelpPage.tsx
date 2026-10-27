import { HowItWorks } from "../components/HowItWorks";
import { FAQ } from "../components/FAQ";

export function HelpPage() {
  return (
    <section className="help-page section-wrap">
      <div className="support-heading">
        <h1>도움말</h1>
        <p>체험 방법과 자주 묻는 내용을 모았습니다.</p>
      </div>
      <section className="help-how" aria-labelledby="help-how-title">
        <h2 id="help-how-title">이렇게 체험해요.</h2>
        <HowItWorks />
      </section>
      <FAQ />
    </section>
  );
}

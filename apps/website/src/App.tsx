import { Header } from "./components/Header";
import { Hero } from "./components/Hero";
import { FolderDemo } from "./features/demo/FolderDemo";
import { HowItWorks } from "./components/HowItWorks";
import { FAQ } from "./components/FAQ";
import { Footer } from "./components/Footer";

export function App() {
  return (
    <div id="top">
      <a className="skip-link" href="#main">
        본문으로 바로가기
      </a>
      <Header />
      <main id="main">
        <Hero />
        <FolderDemo />
        <HowItWorks />
        <FAQ />
        <Footer />
      </main>
    </div>
  );
}

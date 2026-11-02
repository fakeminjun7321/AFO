import { test, expect } from "@playwright/test";

const macCommand = "curl -fsSL https://raw.githubusercontent.com/fakeminjun7321/AFO/main/install.sh | sh";
const winCommand = "irm https://raw.githubusercontent.com/fakeminjun7321/AFO/main/install.ps1 | iex";

test("home leads with the CLI install, copies the commands and links to the web tools", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /한 줄이면/ })).toBeVisible();
  await page.locator(".hero").getByRole("link", { name: "설치하기" }).click();
  await expect(page).toHaveURL(/#install$/);
  const install = page.locator("#install");
  await expect(install.getByRole("tab", { name: "macOS" })).toBeVisible();
  await install.getByRole("tab", { name: "macOS" }).click();
  await expect(install.locator("code").first()).toHaveText(macCommand);
  await install.getByRole("button", { name: "macOS 설치 명령 복사" }).click();
  await expect(install.getByRole("button", { name: "macOS 설치 명령 복사" })).toHaveText("복사했어요");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(macCommand);
  await install.getByRole("tab", { name: "Windows" }).click();
  await expect(install.locator("code").first()).toHaveText(winCommand);
  await install.getByRole("button", { name: "Windows 설치 명령 복사" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(winCommand);
  await expect(page.getByRole("heading", { name: /네 단계면 정리 끝/ })).toBeVisible();
  await expect(page.getByText(/웹 규칙은 CLI와 자동으로 연결되지 않아요/)).toBeVisible();
  await page.getByRole("link", { name: "내 폴더 분석하기" }).click();
  await expect(page).toHaveURL(/\/preview$/);
  await expect(page.getByRole("heading", { name: /폴더를 열고/ })).toBeVisible();
  await page.goto("/");
  await page.getByRole("link", { name: "나의 규칙 살펴보기" }).click();
  await expect(page).toHaveURL(/\/rules$/);
  await expect(page.getByRole("heading", { name: "나의 규칙", exact: true })).toBeVisible();
  await page.goto("/");
  await page.getByRole("link", { name: "사용 방법 자세히 보기" }).click();
  await expect(page).toHaveURL(/\/help$/);
  await page.getByRole("button", { name: "예시 결과 보기" }).click();
  await expect(page.getByText(/샘플 6개의 예시 결과/)).toBeVisible();
  await page.goto("/guide");
  await expect(page.getByRole("heading", { name: "명령어로 더 자세하게." })).toBeVisible();
  await page.goto("/faq");
  await page.getByText("저장한 규칙이 내 폴더 분석에 적용되나요?").click();
  await expect(page.getByText(/브라우저 보관함에 저장한 활성 규칙이 적용됩니다/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("install, community and notes pages show real project links and verification status", async ({ page }) => {
  await page.goto("/install");
  await expect(page.getByRole("heading", { name: "설치", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "코드 서명이 없어요" })).toBeVisible();
  await page.goto("/community");
  for (const href of ["https://github.com/fakeminjun7321/AFO", "https://github.com/fakeminjun7321/AFO/issues", "https://github.com/fakeminjun7321/AFO/releases", "https://github.com/fakeminjun7321/AFO/issues/new"]) {
    await expect(page.locator(`main a[href="${href}"]`).first()).toBeVisible();
  }
  await expect(page.getByText(/별도 포럼이나 채팅방이 없습니다/)).toBeVisible();
  await page.goto("/status");
  await expect(page).toHaveURL(/\/notes$/);
  await expect(page.getByRole("heading", { name: "검증 상태" })).toBeVisible();
  await expect(page.getByText(/Windows 실제 PC에서는 아직 확인하지 않았고/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "남은 일" })).toBeVisible();
  for (const n of [20, 47, 49, 48, 50, 53, 54, 55, 56]) {
    await expect(page.locator(`a[href="https://github.com/fakeminjun7321/AFO/pull/${n}"]`).first()).toBeAttached();
  }
});

test("home content stays within the viewport at desktop and mobile widths", async ({ page }) => {
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/", "/install", "/community", "/notes"]) {
      await page.goto(path);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${path} width ${width}`).toBeTruthy();
    }
    await page.goto("/");
    await expect(page.getByRole("link", { name: "내 폴더 분석하기" })).toBeVisible();
  }
});

test("beginner install guide walks through macOS and Windows steps with copyable commands", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("link", { name: "터미널이 처음이라면" }).click();
  await expect(page).toHaveURL(/\/install#beginner$/);
  const guide = page.locator("#beginner");
  await expect(guide.getByRole("heading", { name: "터미널이 처음이라면" })).toBeInViewport();
  await guide.getByRole("tab", { name: "macOS" }).click();
  await expect(guide.getByRole("heading", { name: "터미널 열기" })).toBeVisible();
  await expect(guide.getByText(/응용 프로그램 → 유틸리티 → 터미널/)).toBeVisible();
  await expect(guide.locator(".beginner-steps > li")).toHaveCount(5);
  await guide.getByRole("button", { name: "설치 명령 붙여 넣기: 명령 복사" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("curl -fsSL https://raw.githubusercontent.com/fakeminjun7321/AFO/main/install.sh | sh");
  await guide.getByRole("tab", { name: "Windows" }).click();
  await expect(guide.getByRole("heading", { name: "PowerShell 열기" })).toBeVisible();
  await expect(guide.getByText(/실제 Windows PC에서는 아직 검증하지 않았어요/)).toBeVisible();
  await guide.getByRole("button", { name: "설치 명령 붙여 넣기: 명령 복사" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("irm https://raw.githubusercontent.com/fakeminjun7321/AFO/main/install.ps1 | iex");
  await guide.getByText("macOS: zsh: command not found: afo").click();
  await expect(guide.getByText(/source ~\/\.zshrc/)).toBeVisible();
  await expect(page.getByText(/v0\.2\.0 릴리스부터 들어 있어요/)).toBeVisible();
});

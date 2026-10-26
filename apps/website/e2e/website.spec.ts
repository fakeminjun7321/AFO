import { test, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";

test("public routes, responsive navigation, sample demo and real local rule persistence", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      "/",
      "/guide",
      "/help",
      "/demo",
      "/faq",
      "/login",
      "/signup",
      "/reset-password",
      "/rules",
    ]) {
      await page.goto(path);
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator("h1")).toBeVisible();
      await expect(page).toHaveTitle(/^AFO — /);
      await expect(page.locator("vite-error-overlay")).toHaveCount(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBeTruthy();
    }
  }
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "직접 체험" })
    .click();
  await expect(page).toHaveURL(/\/demo$/);
  await page.getByRole("button", { name: "분류 미리보기" }).click();
  await page.getByLabel("문서 분류 기준").selectOption("personal");
  await expect(page.getByText("학교/물리", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "다시 체험하기" }).click();
  await expect(
    page.getByRole("button", { name: "분류 미리보기" }),
  ).toBeVisible();
  await page.goto("/rules");
  await page.getByRole("button", { name: /규칙 추가/ }).click();
  await page.getByLabel("규칙 1 키워드").fill("물리");
  await page.getByLabel("규칙 1 폴더").fill("학교/물리");
  await page.getByRole("button", { name: "브라우저에 저장" }).click();
  await expect(page.getByRole("status")).toContainText(
    "이 브라우저에 저장했어요",
  );
  await page.reload();
  await expect(page.getByLabel("규칙 1 폴더")).toHaveValue("학교/물리");
  if (process.env.AFO_EVIDENCE_DIR) {
    await mkdir(process.env.AFO_EVIDENCE_DIR, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({
        path: `${process.env.AFO_EVIDENCE_DIR}/rules-${width}.png`,
        fullPage: true,
      });
    }
  }
  const downloadEvent = page.waitForEvent("download");
  await page.getByText("JSON으로 가져오기·내보내기", { exact: true }).click();
  await page.getByRole("button", { name: "JSON 내보내기" }).click();
  const download = await downloadEvent;
  const json = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(json.rules[0].targetDirectory).toBe("학교/물리");
  expect(Object.keys(json).sort()).toEqual(["formatVersion", "name", "rules"]);
  await page.getByLabel("규칙 1 폴더").fill("../outside");
  await page.getByRole("button", { name: "브라우저에 저장" }).click();
  await expect(page.getByRole("alert")).toContainText("상위 폴더");
  await page.getByLabel("규칙 JSON 가져오기").setInputFiles({
    name: "rules.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(json)),
  });
  await expect(page.getByLabel("규칙 1 폴더")).toHaveValue("학교/물리");
  await page.getByLabel("규칙 JSON 가져오기").setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from("{"),
  });
  await expect(page.getByRole("alert")).toContainText("JSON을 읽지 못했습니다");
  await expect(page.getByLabel("규칙 1 폴더")).toHaveValue("학교/물리");
  expect(errors).toEqual([]);
});

async function signup(page: import("@playwright/test").Page, email: string) {
  await page.goto("/signup");
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill("Synthetic-Only-274!");
  await page.getByLabel("비밀번호 확인").fill("Synthetic-Only-274!");
  await page.getByRole("button", { name: "계정 만들기" }).click();
  await expect(page).toHaveURL(/\/account$/);
}
test("Auth + Firestore Emulator: save/reload, account isolation and stale version rejection", async ({
  browser,
}) => {
  const one = await browser.newContext();
  const page = await one.newPage();
  const email = `rules-${Date.now()}@example.invalid`;
  await signup(page, email);
  await page.goto("/rules");
  await expect(page.getByLabel("규칙 모음 이름")).toHaveValue("나의 분류 규칙");
  await page.getByRole("button", { name: "클라우드에서 불러오기" }).click();
  await expect(page.getByRole("status")).toContainText(
    "아직 클라우드에 저장한 규칙이 없습니다",
  );
  await page.getByRole("button", { name: /규칙 추가/ }).click();
  await page.getByLabel("규칙 1 폴더").fill("학교/물리");
  await page.getByRole("button", { name: "클라우드에 저장" }).click();
  await expect(page.getByRole("status")).toContainText(
    "클라우드 버전 1로 저장",
  );
  const accounts = await (
    await fetch(
      "http://127.0.0.1:19103/identitytoolkit.googleapis.com/v1/projects/demo-afo-website/accounts:batchGet",
      { headers: { Authorization: "Bearer owner" } },
    )
  ).json();
  const uid = accounts.users.find(
    (u: { email: string }) => u.email === email,
  ).localId;
  const root =
    "http://127.0.0.1:18103/v1/projects/demo-afo-website/databases/(default)/documents";
  const inspect = { headers: { Authorization: "Bearer owner" } };
  const metaResponse = await fetch(
    `${root}/users/${uid}/ruleSets/personal`,
    inspect,
  );
  expect(metaResponse.status).toBe(200);
  const meta = await metaResponse.json();
  expect(meta.fields.revision.integerValue).toBe("1");
  const ruleId = meta.fields.ruleIds.arrayValue.values[0].stringValue;
  const child = await (
    await fetch(
      `${root}/users/${uid}/ruleSets/personal/rules/1_${ruleId}`,
      inspect,
    )
  ).json();
  expect(child.fields.targetDirectory.stringValue).toBe("학교/물리");
  const second = await one.newPage();
  await second.goto("/rules");
  await second.getByRole("button", { name: "클라우드에서 불러오기" }).click();
  await expect(second.getByLabel("규칙 1 폴더")).toHaveValue("학교/물리");
  await page.getByLabel("규칙 1 폴더").fill("학교/화학");
  await page.getByRole("button", { name: "클라우드에 저장" }).click();
  await expect(page.getByRole("status")).toContainText(
    "클라우드 버전 2로 저장",
  );
  await page.getByLabel("규칙 1 폴더").fill("오프라인/수정");
  await one.setOffline(true);
  await page.getByRole("button", { name: "클라우드에 저장" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "클라우드 저장 결과를 확인하지 못했습니다",
    { timeout: 20000 },
  );
  await expect(
    page.getByRole("button", { name: "클라우드에 저장" }),
  ).toBeDisabled();
  await one.setOffline(false);
  await second.getByRole("button", { name: "클라우드에 저장" }).click();
  await expect(second.getByRole("alert")).toContainText(
    "다른 창에서 규칙이 바뀌었습니다",
  );
  await expect(
    second.getByRole("button", { name: "클라우드에 저장" }),
  ).toBeDisabled();
  await page.reload();
  await page.getByRole("button", { name: "클라우드에서 불러오기" }).click();
  await expect(page.getByLabel("규칙 1 폴더")).toHaveValue("학교/화학");
  await page.goto("/account");
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/rules");
  await expect(page.getByLabel("규칙 1 폴더")).toHaveCount(0);
  await signup(page, `other-${Date.now()}@example.invalid`);
  await page.goto("/rules");
  await page.getByRole("button", { name: "클라우드에서 불러오기" }).click();
  await expect(page.getByRole("status")).toContainText(
    "아직 클라우드에 저장한 규칙이 없습니다",
  );
  await one.close();
});

test("resource pages serve a real test ZIP and importable example rules", async ({
  page,
}) => {
  const { createHash } = await import("node:crypto");
  const pack = JSON.parse(
    await readFile(
      new URL("../src/data/test-pack.json", import.meta.url),
      "utf8",
    ),
  );
  for (const path of ["/resources", "/downloads", "/notes"]) {
    await page.goto(path);
    await expect(page.locator("h1")).toHaveCount(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
  }
  await page.goto("/downloads");
  const fileEvent = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "테스트 ZIP 받기", exact: false })
    .click();
  const file = await fileEvent;
  const bytes = await readFile((await file.path())!);
  expect(bytes.length).toBe(pack.bytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(pack.sha256);
  const jsonEvent = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "예시 규칙 JSON만 받기", exact: false })
    .click();
  const jsonFile = await jsonEvent;
  await page.goto("/rules");
  await page.getByText("JSON으로 가져오기·내보내기", { exact: true }).click();
  await page
    .getByLabel("규칙 JSON 가져오기")
    .setInputFiles((await jsonFile.path())!);
  await expect(page.getByLabel("규칙 1 폴더")).toHaveValue("학교/물리");
});

test("Admin callable enforces server authorization and returns real emulator user/runtime data", async ({
  browser,
}) => {
  const endpoint =
    "http://127.0.0.1:15193/demo-afo-website/asia-northeast3/adminOverview";
  const unauth = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: {} }),
  });
  expect(unauth.status).toBe(401);
  const identity = "http://127.0.0.1:19103/identitytoolkit.googleapis.com/v1/";
  async function create(email: string, verified: boolean, adminClaim: boolean) {
    const created = await (
      await fetch(identity + "accounts:signUp", {
        method: "POST",
        headers: {
          Authorization: "Bearer owner",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          password: "Synthetic-Only-274!",
          emailVerified: verified,
          targetProjectId: "demo-afo-website",
        }),
      })
    ).json();
    if (adminClaim)
      await fetch(identity + "accounts:update", {
        method: "POST",
        headers: {
          Authorization: "Bearer owner",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          localId: created.localId,
          targetProjectId: "demo-afo-website",
          customAttributes: JSON.stringify({ admin: true }),
        }),
      });
    const signed = await (
      await fetch(
        identity + "accounts:signInWithPassword?key=demo-afo-website",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            password: "Synthetic-Only-274!",
            returnSecureToken: true,
          }),
        },
      )
    ).json();
    return signed.idToken as string;
  }
  for (const [verified, claim] of [
    [true, false],
    [false, true],
  ]) {
    const token = await create(
      `denied-${Date.now()}-${verified}@example.invalid`,
      verified,
      claim,
    );
    const denied = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: {} }),
    });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.status).toBe("PERMISSION_DENIED");
  }
  const email = `admin-${Date.now()}@example.invalid`;
  await create(email, true, true);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill("Synthetic-Only-274!");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
  await page.getByRole("link", { name: "관리자 화면", exact: true }).click();
  await page.getByRole("button", { name: "관리 정보 불러오기" }).click();
  await expect(page.locator(".admin-users")).toContainText(email, {
    timeout: 20000,
  });
  await expect(page.locator(".admin-runtime")).toContainText(
    "demo-afo-website",
  );
  await expect(page.locator(".admin-runtime")).toContainText("연결됨");
  expect(await page.locator("main").innerText()).not.toMatch(
    /passwordHash|passwordSalt|refreshToken/,
  );
  if (process.env.AFO_EVIDENCE_DIR) {
    await mkdir(process.env.AFO_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
      path: `${process.env.AFO_EVIDENCE_DIR}/admin-data.png`,
      fullPage: true,
    });
  }
  await context.close();
});

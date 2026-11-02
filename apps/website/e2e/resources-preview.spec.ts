import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);

test("downloaded synthetic pack imports rules and previews its duplicate files", async ({ page }) => {
  const tmp = await mkdtemp(join(tmpdir(), "afo-pack-e2e-"));
  try {
    await page.goto("/resources");
    await page.getByRole("link", { name: /테스트 파일/ }).click();
    await expect(page).toHaveURL(/\/downloads$/);
    const event = page.waitForEvent("download");
    await page.getByRole("link", { name: /테스트 ZIP 받기/ }).click();
    const download = await event;
    const archivePath = (await download.path())!;
    const meta = JSON.parse(await readFile(new URL("../src/data/test-pack.json", import.meta.url), "utf8"));
    expect(createHash("sha256").update(await readFile(archivePath)).digest("hex")).toBe(meta.sha256);
    await run("python3", ["-c", "import pathlib,sys,zipfile\ndst=pathlib.Path(sys.argv[2]).resolve()\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n assert all((dst / i.filename).resolve().is_relative_to(dst) for i in z.infolist())\n z.extractall(dst)", archivePath, tmp]);
    const pack = join(tmp, "AFO_테스트파일");
    const sample = join(pack, "정리할파일");
    const source = join(sample, "물리_실험.txt");
    const before = createHash("sha256").update(await readFile(source)).digest("hex");
    await page.goto("/rules");
    await page.getByText("JSON으로 가져오기·내보내기", { exact: true }).click();
    await page.getByLabel("규칙 JSON 가져오기").setInputFiles(join(pack, "예시_규칙.json"));
    await expect(page.getByLabel("규칙 1 폴더")).toHaveValue("학교/물리");
    await page.getByRole("button", { name: "브라우저에 저장" }).click();
    await expect(page.getByRole("status")).toContainText("이 브라우저에 저장했어요");
    await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "웹 미리보기" }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "폴더 선택하기" }).click();
    await (await chooser).setFiles(sample);
    await expect(page.getByText("파일 7개 분석")).toBeVisible();
    await expect(page.getByText("학교/물리/물리_실험.txt")).toBeVisible();
    await page.getByRole("button", { name: "중복 검사 시작" }).click();
    await expect(page.getByText(/동일한 해시의 후보 1그룹/)).toBeVisible();
    await expect(page.locator(".local-duplicate-group")).toContainText("물리_실험.txt");
    await expect(page.locator(".local-duplicate-group")).toContainText("물리_실험_복사본.txt");
    expect(createHash("sha256").update(await readFile(source)).digest("hex")).toBe(before);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("selected synthetic folder is classified without changing files", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "afo-browser-preview-"));
  try {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "report.pdf"), "synthetic document");
    await writeFile(join(root, "photo.png"), "synthetic image");
    await writeFile(join(root, "unknown.xyz"), "synthetic unknown");
    await writeFile(join(root, ".hidden"), "synthetic hidden");
    await page.goto("/preview");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "폴더 선택하기" }).click();
    await (await chooser).setFiles(root);
    await expect(page.getByText("nested/report.pdf")).toBeVisible();
    await expect(page.getByText(/숨김 경로의 파일 1개/)).toBeVisible();
    await expect(page.getByRole("button", { name: "확인 필요 1" })).toBeVisible();
    await page.getByRole("button", { name: "문서 1" }).click();
    await expect(page.getByText("photo.png")).toHaveCount(0);
    await expect(page.getByText("nested/report.pdf")).toBeVisible();
    expect(await readFile(join(root, "nested", "report.pdf"), "utf8")).toBe("synthetic document");
  } finally { await rm(root, { recursive: true, force: true }); }
});

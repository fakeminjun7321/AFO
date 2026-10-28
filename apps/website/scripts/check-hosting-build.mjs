import { readFileSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Run from the website directory. Refuse to use a different site or deploy non-static products.
try {
  const config = JSON.parse(readFileSync("firebase.json", "utf8"));
  const hosting = config.hosting;
  if (!hosting || Array.isArray(hosting) || hosting.site !== "afo-hackathon-2026-7321" || hosting.public !== "dist")
    throw new Error("Hosting site or output directory is not the approved target.");
  if (config.functions || (hosting.rewrites ?? []).some((rule) => "function" in rule || "run" in rule || "dynamicLinks" in rule))
    throw new Error("Only the static Hosting site may be deployed.");
  const services = JSON.parse(readFileSync("src/config/services.public.json", "utf8"));
  if (services.adminApi !== false) throw new Error("The public administrator API must remain disabled.");
  const directory = lstatSync(resolve("dist"));
  const index = lstatSync(resolve("dist/index.html"));
  if (!directory.isDirectory() || directory.isSymbolicLink() || !index.isFile() || index.isSymbolicLink())
    throw new Error("The built website output is missing or not a regular directory.");
  const pending = [resolve("dist")];
  while (pending.length) {
    const dir = pending.pop();
    for (const name of readdirSync(dir)) {
      const item = join(dir, name), stat = lstatSync(item);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new Error("The website output contains a link or non-regular file.");
      if (stat.isDirectory()) pending.push(item);
    }
  }
  console.log("Static Hosting target and build validated.");
} catch (error) {
  console.error(`Hosting configuration rejected: ${error instanceof Error ? error.message : "invalid configuration"}`);
  process.exitCode = 1;
}

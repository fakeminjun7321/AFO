import { mkdir, copyFile } from "node:fs/promises";
import { spawn } from "node:child_process";
await mkdir(new URL("../.emulator/", import.meta.url), { recursive: true });
// Firebase CLI confines rule paths to the config directory; generate an ignored exact copy.
await copyFile(new URL("../../../firebase/firestore.rules", import.meta.url), new URL("../.emulator/firestore.rules", import.meta.url));
const child = spawn(process.execPath, ["../../firebase/node_modules/firebase-tools/lib/bin/firebase.js", "emulators:start", "--only", "auth,firestore,hosting", "--config", "firebase.emulator.json", "--project", "demo-afo-website", "--non-interactive"], { stdio: "inherit", env: process.env });
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => child.kill(signal));

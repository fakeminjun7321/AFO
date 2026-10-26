import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const cache = path.join(cwd, '.cache');
await mkdir(cache, { recursive: true });
const child = spawn(process.execPath, [path.join(cwd, 'node_modules/firebase-tools/lib/bin/firebase.js'),
  '--non-interactive', 'emulators:exec', '--config', 'firebase.test.json', '--project', 'demo-afo-tests',
  '--only', 'auth,firestore,hosting', 'node --test dist/tests/firestore.test.js'], {
  cwd, stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, FIREBASE_EMULATORS_PATH: path.join(cache, 'emulators'),
    XDG_CONFIG_HOME: path.join(cache, 'config'), JAVA_TOOL_OPTIONS: '-Xmx512m' },
});
child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
let invalidPolicyEvaluation = false;
for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  let tail = '';
  stream.on('data', (chunk) => {
    output.write(chunk);
    const text = tail + chunk.toString();
    if (/maximum of 1000 expressions|maximum.*document access/i.test(text)) invalidPolicyEvaluation = true;
    tail = text.slice(-512);
  });
}
child.once('exit', (code) => {
  if (invalidPolicyEvaluation) console.error('보안 규칙의 평가 한도로 거부된 요청은 정상 검증으로 인정하지 않습니다.');
  process.exitCode = invalidPolicyEvaluation ? 1 : code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));

#!/usr/bin/env node
// 하네스 시험 드릴: verifier가 결함을 잡고 수정·재검증 루프가 작동하는지 확인하려고
// 시험 과업(T-000) 구현에 알려진 결함을 하나 주입한다. 실제 과업에는 쓰지 않는다.
//   node scripts/harness/drills/inject-defect.mjs T-000
import fs from 'node:fs';
import path from 'node:path';
import { projectDir, appendLine, nowIso } from '../lib/core.mjs';

const DRILLS = {
  'T-000': {
    file: 'docs/harness/pilot/format-duration.mjs',
    // 수용 기준: 잘못된 입력은 RangeError. 이를 TypeError로 바꿔 계약 위반을 만든다.
    mutate: (src) => src.replaceAll('RangeError', 'TypeError'),
    description: '잘못된 입력에서 RangeError 대신 TypeError를 던지게 바꿈',
  },
};

const id = process.argv[2];
const drill = DRILLS[id];
if (!drill) { console.error(`드릴 없음: ${id}`); process.exit(2); }
const root = projectDir();
const file = path.join(root, drill.file);
if (!fs.existsSync(file)) { console.error(`대상 파일 없음: ${drill.file}`); process.exit(1); }
const before = fs.readFileSync(file, 'utf8');
const after = drill.mutate(before);
if (after === before) { console.error('주입할 위치를 찾지 못했습니다(구현에 RangeError가 없음).'); process.exit(1); }
fs.writeFileSync(file, after);
appendLine('.afo/state/drills.log', JSON.stringify({ ts: nowIso(), task: id, file: drill.file, description: drill.description }), root);
console.log(`결함 주입 완료: ${drill.file} — ${drill.description}`);

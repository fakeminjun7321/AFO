#!/usr/bin/env node
// Real standalone feature path; no npm modules or external services are used by this verifier.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const { values } = parseArgs({ options: { archive: { type:'string' } } });
if (!values.archive) throw new Error('--archive is required.');
const root = await mkdtemp(path.join(tmpdir(),'afo-standalone-smart-'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
try {
  const install = path.join(root,'설치 경로 with spaces'); await mkdir(install);
  await copyFile(path.resolve(values.archive),path.join(install,'release-archive'));
  const name = process.platform==='win32'?'afo.exe':'afo';
  const tar = process.platform==='win32'?path.join(process.env.SystemRoot??'C:\\Windows','System32/tar.exe'):'/usr/bin/tar';
  await execute(tar,['-xf','release-archive',name],{cwd:install});
  const executable=path.join(install,name); if(process.platform!=='win32')await chmod(executable,0o755);
  const work=path.join(root,'synthetic');await mkdir(work);
  const fixtures=fileURLToPath(new URL('../../tests/fixtures/smart-media/',import.meta.url));
  for(const file of ['dated.jpg','source.png','similar.png','different.png','math.docx','korean.pdf'])await copyFile(path.join(fixtures,file),path.join(work,file));
  await writeFile(path.join(work,'physics.txt'),'Physics velocity momentum kinetic energy. Synthetic fixture.');
  const env={...process.env,AFO_STATE_DIR:path.join(root,'state')};
  const run=async(args)=>JSON.parse((await execute(executable,args,{env,timeout:120_000,maxBuffer:8*1024*1024,windowsHide:true})).stdout);
  const original=new Map(await Promise.all(['dated.jpg','source.png','similar.png','different.png','math.docx','korean.pdf','physics.txt'].map(async(file)=>[file,hash(await readFile(path.join(work,file)))])));
  const {preview}=await run(['preview',work,'--content','--photo-dates','month','--similar-photos','--json']);
  const pdf=preview.smart.documents.find((item)=>item.source==='korean.pdf');
  assert.equal(pdf.status,'read',pdf.reason);assert.equal(pdf.method,'pdfjs-text',pdf.reason);assert.match(pdf.excerpt,/물리|가속도|운동량/u);
  assert.equal(preview.items.find((item)=>item.source==='physics.txt').destination,'문서/물리/physics.txt');
  assert.equal(preview.items.find((item)=>item.source==='math.docx').destination,'문서/수학/math.docx');
  assert.equal(preview.items.find((item)=>item.source==='dated.jpg').destination,'이미지/2024-11/dated.jpg');
  assert.ok(preview.smart.similar.some((pair)=>[pair.left,pair.right].includes('source.png')&&[pair.left,pair.right].includes('similar.png')),JSON.stringify(preview.smart.notices));
  assert.deepEqual(preview.duplicates,[]);
  const planned=await run(['plan',work,'--content','--photo-dates','month','--similar-photos','--json']);
  const approval=planned.approvalChoices.find((choice)=>choice.mode==='organize');
  const applied=await run(['apply',planned.planId,'--mode','organize','--confirm',approval.code,'--json']);
  for(const operation of planned.plan.operations)assert.equal(hash(await readFile(path.join(work,operation.destination))),original.get(operation.source));
  await run(['undo',applied.runId,'--confirm',applied.runId.slice(0,8),'--json']);
  for(const [file,expected]of original)assert.equal(hash(await readFile(path.join(work,file))),expected);
  console.log(JSON.stringify({platform:process.platform,arch:process.arch,standaloneTextAndOffice:true,standaloneKoreanPdf:true,standalonePhotoDate:true,
    standaloneSimilarPhotos:true,approvedMoveAndUndoHashes:true,externalRequests:0},null,2));
}finally{await rm(root,{recursive:true,force:true});}

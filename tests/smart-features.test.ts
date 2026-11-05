import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { ComplexRuleSchema } from '../packages/contracts/src/index.js';
import type { OperationPlan, Preview, SmartReport } from '../packages/contracts/src/index.js';
import { buildPreview, classifyFile, emptyProfile } from '../packages/engine/src/index.js';
import { complexMatches, conditionMatches, hamming, similarPhotos } from '../packages/engine/src/smart.js';
import { categoryExtensions } from '../packages/engine/src/defaults.js';
import { run, runCli } from '../apps/cli/src/index.js';
import { fixture, manifest, scanFixture } from './helpers.js';

const sampleRule = (changes: Record<string, unknown> = {}) => ComplexRuleSchema.parse({ id: '1'.repeat(16), name: '물리 보고서', enabled: true,
  match: 'all', priority: 10, targetDirectory: '과제/물리', conditions: [
    { field: 'extension', operator: 'equals', value: '.pdf' }, { field: 'name', operator: 'contains', value: '물리' },
  ], ...changes });
const profile = (rules = [sampleRule()]) => ({ ...emptyProfile('test-smart', 1), complexRules: rules });
const media = (name: string) => fileURLToPath(new URL(`../../tests/fixtures/smart-media/${name}`, import.meta.url));
const options = (root: string) => ({ stateDir: path.join(root, 'state'), warn: () => {} });
async function preview(root: string, flags: string[] = []): Promise<Preview> {
  return (JSON.parse(await run(['preview', path.join(root, 'work'), ...flags, '--json'], undefined, options(root))) as { preview: Preview }).preview;
}
function pdf(text: string): Buffer {
  const stream = `BT /F1 16 Tf 40 760 Td (${text.replace(/[()\\]/gu, ' ')}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let body = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

test('expanded classification keeps ambiguous extensions excluded and assigns representative new formats', () => {
  const expected: Record<string, string> = { 'notes.markdown':'문서','slides.ppsx':'문서','raw.raf':'이미지','movie.mxf':'영상',
    'music.caf':'음악','bundle.whl':'압축','app.msixbundle':'설치','model.glb':'디자인','font.eot':'글꼴','book.fb2':'전자책','view.vue':'코드','experiment.fits':'데이터','record.cap':'데이터' };
  for (const [name, category] of Object.entries(expected)) assert.equal(classifyFile(name).category, category, name);
  for (const ext of ['ts','m','bin','dat','tmp','lnk']) assert.equal(classifyFile(`unknown.${ext}`).targetDirectory, null);
  const extensions = Object.values(categoryExtensions).flat(); assert.equal(new Set(extensions).size, extensions.length);
  assert.ok(extensions.length > 300);
});

test('AND/OR rules use metadata only when provided, respect priority, and preserve explicit choices', () => {
  const and = sampleRule(); assert.ok(complexMatches(and,'물리_보고서.pdf')); assert.equal(complexMatches(and,'화학.pdf'),false);
  const or = sampleRule({ match:'any' }); assert.ok(complexMatches(or,'물리.txt')); assert.ok(complexMatches(or,'화학.pdf'));
  assert.equal(conditionMatches({field:'size',operator:'at-least',value:100},'a.pdf'),false);
  assert.equal(conditionMatches({field:'modified',operator:'before',value:'2026-01-01'},'a.pdf',{size:1}),false);
  assert.equal(conditionMatches({field:'size',operator:'at-least',value:0},'a.pdf',{modifiedNs:'0'}),false);
  assert.equal(classifyFile('물리.pdf',{profile:profile()}).targetDirectory,'과제/물리');
  assert.equal(classifyFile('물리.pdf',{profile:profile(),override:'이번만'}).targetDirectory,'이번만');
  const low = sampleRule({id:'2'.repeat(16),targetDirectory:'낮은우선',priority:1});
  assert.equal(classifyFile('물리.pdf',{profile:profile([low,and])}).targetDirectory,'과제/물리');
  const clash=sampleRule({id:'3'.repeat(16),targetDirectory:'충돌'});
  assert.equal(classifyFile('물리.pdf',{profile:profile([and,clash])}).reasonCode,'RULE_CONFLICT');
  assert.equal(classifyFile('물리.pdf',{profile:{...profile(),status:'disabled'}}).category,'문서');
  assert.equal(classifyFile('물리.pdf.exe',{profile:profile([sampleRule({conditions:[{field:'name',operator:'contains',value:'물리'}]})])}).reasonCode,'COMPOUND_EXTENSION');
});

test('keep-both resolves existing and planned name collisions without authorizing overwrites', () => {
  const scan=scanFixture(['report.pdf','sub/report.pdf','문서/report.pdf']); scan.directories=['sub','문서'];
  const unchanged=buildPreview(scan); assert.equal(unchanged.items[0]!.action,'review');
  const both=buildPreview(scan,{conflicts:'keep-both'});
  assert.equal(both.items[0]!.destination,'문서/report (1).pdf'); assert.equal(both.items[1]!.destination,'문서/report (2).pdf');
  assert.equal(both.items[2]!.action,'keep'); assert.notEqual(both.id,unchanged.id);
  assert.throws(()=>buildPreview(scan,{renames:{[scan.files[0]!.id]:'../escaped.pdf'}}));
});

test('CLI saves/edits/tests/toggles/removes real compound rules and preserves source files', async(t)=>{
  const root=await fixture(t,{'work/물리_보고서.pdf':'synthetic physics','work/화학.pdf':'chemistry','state/':''}); const io=options(root); const before=await manifest(path.join(root,'work'));
  const file=path.join(root,'rule.json'); const rule=sampleRule(); await writeFile(file,JSON.stringify(rule));
  await run(['rules','add',file,'--json'],undefined,io);
  assert.equal((await preview(root)).items.find((i)=>i.source==='물리_보고서.pdf')!.destination,'과제/물리/물리_보고서.pdf');
  const tested=JSON.parse(await run(['rules','test','물리_보고서.pdf','--json'],undefined,io)); assert.equal(tested.matches[0].matched,true);
  await writeFile(file,JSON.stringify({...rule,targetDirectory:'새폴더'})); await run(['rules','edit',file],undefined,io);
  assert.equal((await preview(root)).items.find((i)=>i.source==='물리_보고서.pdf')!.destination,'새폴더/물리_보고서.pdf');
  await run(['rules','disable',rule.id],undefined,io); assert.equal((await preview(root)).items[0]!.category,'문서');
  await run(['rules','remove',rule.id],undefined,io); const saved=JSON.parse(await run(['rules','list','--json'],undefined,io)); assert.deepEqual(saved.profile.complexRules,[]);
  assert.deepEqual(await manifest(path.join(root,'work')),before);
});

test('CLI keep-both and explicit rename move real files and undo restores paths and hashes', async(t)=>{
  const root=await fixture(t,{'work/report.pdf':'one','work/sub/report.pdf':'two','work/문서/report.pdf':'existing','state/':''}); const io=options(root); const work=path.join(root,'work');
  const before=await manifest(work);
  const planned=JSON.parse(await run(['plan',work,'--conflicts','keep-both','--json'],undefined,io)) as {planId:string;plan:OperationPlan;approvalChoices:{mode:string;code:string}[]};
  const approved=planned.approvalChoices.find((c)=>c.mode==='organize')!;
  const applied=await runCli(['apply',planned.planId,'--mode','organize','--confirm',approved.code,'--json'],undefined,io); assert.equal(applied.exitCode,0);
  const result=JSON.parse(applied.output) as {runId:string};
  assert.equal(await readFile(path.join(work,'문서/report.pdf'),'utf8'),'existing');
  assert.equal(await readFile(path.join(work,'문서/report (1).pdf'),'utf8'),'one'); assert.equal(await readFile(path.join(work,'문서/report (2).pdf'),'utf8'),'two');
  const undone=await runCli(['undo',result.runId,'--confirm',result.runId.slice(0,8),'--json'],undefined,io); assert.equal(undone.exitCode,0);
  const after=await manifest(work); assert.deepEqual(Object.fromEntries(Object.entries(after).filter(([,entry])=>entry.type==='file')),
    Object.fromEntries(Object.entries(before).filter(([,entry])=>entry.type==='file')));
  const renamed=await preview(root,['--rename','report.pdf=보고서 최종.pdf']); assert.equal(renamed.items.find((i)=>i.source==='report.pdf')!.destination,'문서/보고서 최종.pdf');
  await assert.rejects(run(['preview',work,'--rename','report.pdf=../x.pdf'],undefined,io));
});

test('plain text, PDF, DOCX, PPTX, XLSX and HWPX contents are actually extracted and hashed', async(t)=>{
  const root=await fixture(t,{'work/lesson.txt':'Physics velocity momentum kinetic energy.','state/':''}); const work=path.join(root,'work');
  const writeZip=async(name:string,entries:Record<string,string>)=>writeFile(path.join(work,name),zipSync(Object.fromEntries(Object.entries(entries).map(([key,value])=>[key,strToU8(value)]))));
  await writeFile(path.join(work,'physics.pdf'),pdf('Physics velocity momentum kinetic energy.'));
  await writeZip('math.docx',{'word/document.xml':'<w:document><w:body><w:p><w:r><w:t>Calculus derivative integral differential equation.</w:t></w:r></w:p></w:body></w:document>'});
  await writeZip('slides.pptx',{'ppt/slides/slide1.xml':'<a:p><a:r><a:t>Chemistry molarity titration.</a:t></a:r></a:p>'});
  await writeZip('table.xlsx',{'xl/sharedStrings.xml':'<sst><si><t>Physics velocity momentum.</t></si></sst>','xl/worksheets/sheet1.xml':'<worksheet><c t="s"><v>0</v></c></worksheet>'});
  await writeZip('note.hwpx',{'Contents/section0.xml':'<hp:section><hp:p><hp:run><hp:t>물리 역학 가속도 운동량</hp:t></hp:run></hp:p></hp:section>'});
  const before=await manifest(work); const p=await preview(root,['--content']);
  assert.equal(p.smart!.documents.length,6);
  assert.equal(p.smart!.documents.find((d)=>d.source==='physics.pdf')!.method,'pdfjs-text');
  for(const d of p.smart!.documents) {assert.ok(['read','limited'].includes(d.status),d.source+': '+d.reason); assert.ok(d.characters>10);}
  assert.equal(p.items.find((i)=>i.source==='lesson.txt')!.destination,'문서/물리/lesson.txt');
  assert.equal(p.items.find((i)=>i.source==='math.docx')!.destination,'문서/수학/math.docx');
  assert.equal(p.items.find((i)=>i.source==='note.hwpx')!.destination,'문서/물리/note.hwpx');
  const plan=JSON.parse(await run(['plan',work,'--content','--json'],undefined,options(root))) as {plan:OperationPlan};
  for(const op of plan.plan.operations) assert.match(op.expected.sha256!,/^[a-f0-9]{64}$/u);
  assert.deepEqual(await manifest(work),before);
});

test('unsupported/encrypted/malformed formats and compressed-size limits are reported without changing inputs',async(t)=>{
  const root=await fixture(t,{'work/bad.pdf':'not a PDF','work/legacy.hwp':'synthetic unsupported format','state/':''});
  const bomb=Buffer.from(zipSync({'word/document.xml':strToU8('<w:t>small</w:t>')})); const position=bomb.indexOf(Buffer.from([0x50,0x4b,0x01,0x02])); bomb.writeUInt32LE(64*1024*1024,position+24);
  await writeFile(path.join(root,'work/bomb.docx'),bomb); const before=await manifest(path.join(root,'work')); const p=await preview(root,['--content']);
  assert.equal(p.smart!.documents.find((d)=>d.source==='legacy.hwp')!.status,'unsupported');
  assert.equal(p.smart!.documents.find((d)=>d.source==='bad.pdf')!.status,'failed');
  assert.equal(p.smart!.documents.find((d)=>d.source==='bomb.docx')!.status,'failed'); assert.equal(p.smart!.complete,false);
  assert.deepEqual(await manifest(path.join(root,'work')),before);
});

test('captured calendar date and similar photos use real OS pixels while exact duplicate deletion stays separate', {skip:!['darwin','win32'].includes(process.platform)},async(t)=>{
  const root=await fixture(t,{'work/':'','state/':''}); const work=path.join(root,'work');
  for(const name of ['dated.jpg','source.png','similar.png','different.png'])await copyFile(media(name),path.join(work,name));
  const before=await manifest(work); const p=await preview(root,['--photo-dates','month','--similar-photos']);
  assert.equal(p.smart!.photos.find((p)=>p.source==='dated.jpg')!.capturedDate,'2024-11-01');
  assert.equal(p.items.find((i)=>i.source==='dated.jpg')!.destination,'이미지/2024-11/dated.jpg');
  const pairs=p.smart!.similar; assert.ok(pairs.some((p)=>[p.left,p.right].includes('source.png')&&[p.left,p.right].includes('similar.png')),JSON.stringify(p.smart));
  assert.ok(pairs.every((p)=>p.left!=='different.png'&&p.right!=='different.png'));
  assert.deepEqual(p.duplicates,[]); assert.deepEqual(await manifest(work),before);
});

test('OCR reads actual rendered text on this OS or reports the exact missing provider', {skip:!['darwin','win32'].includes(process.platform)},async(t)=>{
  const root=await fixture(t,{'work/':'','state/':''}); await copyFile(media('source.png'),path.join(root,'work/source.png'));
  const p=await preview(root,['--ocr']); const d=p.smart!.documents[0]!;
  if(process.platform==='win32'&&d.status==='failed'&&/no installed recognition language/iu.test(d.reason)){t.skip('Windows OCR language unavailable: '+d.reason);return;}
  assert.equal(d.status,'read',d.reason); assert.match(d.excerpt,/PHYSICS|VELOCITY|MOMENTUM/iu); assert.ok(d.method.includes('ocr'));
});

test('remote AI endpoints and invalid analysis options are rejected before a request',async(t)=>{
  const root=await fixture(t,{'work/a.txt':'physics velocity momentum','state/':''});
  for(const url of ['https://example.com','http://localhost:11434','http://127.0.0.1:11434/remote','http://u:p@127.0.0.1:11434'])
    await assert.rejects(preview(root,['--ai-model','fake','--ai-url',url]));
  await assert.rejects(preview(root,['--similar-threshold','100']));
  assert.equal(hamming('0000000000000000','ffffffffffffffff'),64); assert.deepEqual(similarPhotos([]),[]);
  const formats=JSON.parse(await run(['formats','--json'],undefined,options(root))) as {extensions:string[]}[];
  assert.ok(formats.some((format)=>format.extensions.includes('hwpx')));
});

test('skipping a file excludes it from optional reads, movement and explicit deletion',async(t)=>{
  const root=await fixture(t,{'work/a.txt':'physics velocity momentum','work/b.txt':'other','state/':''});
  const io=options(root);const work=path.join(root,'work');const before=await manifest(work);
  const p=await preview(root,['--skip','a.txt','--content']);
  assert.equal(p.items.find((item)=>item.source==='a.txt')!.reasonCode,'USER_SKIP');
  assert.equal(p.smart!.documents.some((item)=>item.source==='a.txt'),false);
  const planned=JSON.parse(await run(['plan',work,'--skip','a.txt','--json'],undefined,io)) as {plan:OperationPlan};
  assert.equal(planned.plan.operations.some((operation)=>operation.source==='a.txt'),false);
  await assert.rejects(run(['plan',work,'--skip','a.txt','--delete-file','a.txt','--json'],undefined,io));
  assert.deepEqual(await manifest(work),before);
});

test('Korean embedded PDF uses the portable PDF engine and RTF Unicode text is decoded',async(t)=>{
  const root=await fixture(t,{'work/':'','state/':''}); const work=path.join(root,'work');
  await copyFile(media('korean.pdf'),path.join(work,'korean.pdf'));
  const korean='물리 가속도 운동량';const escaped=[...korean].map((ch)=>ch===' '?' ':`\\u${ch.charCodeAt(0)}?`).join('');
  await writeFile(path.join(work,'korean.rtf'),`{\\rtf1\\ansi\\ansicpg1252{\\fonttbl{\\f0 Calculus;}}\\uc1 ${escaped}}`);
  const p=await preview(root,['--content']);
  const document=p.smart!.documents.find((item)=>item.source==='korean.pdf')!;
  assert.equal(document.method,'pdfjs-text',document.reason);assert.equal(document.status,'read',document.reason);assert.match(document.excerpt,/가속도|운동량/u);
  const rich=p.smart!.documents.find((item)=>item.source==='korean.rtf')!;assert.equal(rich.status,'read',rich.reason);assert.match(rich.excerpt,/물리 가속도 운동량/u);assert.doesNotMatch(rich.excerpt,/Calculus/u);
});

test('Korean OCR recognises real rendered Korean text on macOS', {skip:process.platform!=='darwin'},async(t)=>{
  const root=await fixture(t,{'work/':'','state/':''});await copyFile(media('korean.png'),path.join(root,'work/korean.png'));
  const p=await preview(root,['--ocr']);const document=p.smart!.documents[0]!;
  assert.equal(document.status,'read',document.reason);assert.match(document.excerpt,/물리|가속도|운동량/u);
});

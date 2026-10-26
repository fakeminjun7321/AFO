import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase/app';
import { initializeAuth, inMemoryPersistence, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import { initializeFirestore, connectFirestoreEmulator, doc, setDoc, getDocFromServer, deleteDoc, serverTimestamp, terminate, writeBatch } from 'firebase/firestore';
import { createRuleRepository, RevisionConflict, ruleDocumentId } from '../src/index.js';

// Mandatory guard: never silently substitute a real Firebase project or cloud endpoint.
function emulatorAddress(variable: string, expectedPort: string): string {
  const value = process.env[variable];
  if (value !== `127.0.0.1:${expectedPort}` && value !== `localhost:${expectedPort}`)
    throw new Error(`${variable} must identify the configured local emulator.`);
  return value;
}
const firestoreHost = emulatorAddress('FIRESTORE_EMULATOR_HOST', '18080');
const authHost = emulatorAddress('FIREBASE_AUTH_EMULATOR_HOST', '19099');
const projectId = 'demo-afo-tests';
if (process.env['GCLOUD_PROJECT'] !== projectId) throw new Error('Only demo-afo-tests is permitted in integration tests.');

const draft = { formatVersion: 1, name: '테스트 규칙', rules: [
  { id: 'physics-pdf', extension: '.pdf', keyword: '물리', targetDirectory: '과제/물리', enabled: true },
] };
async function client(authenticated = true) {
  const app = initializeApp({ projectId, apiKey: 'demo-only-key', authDomain: 'demo-afo.firebaseapp.com' }, `test-${randomUUID()}`);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true });
  const firestore = initializeFirestore(app, { experimentalForceLongPolling: true });
  const [host, port] = firestoreHost.split(':');
  connectFirestoreEmulator(firestore, host!, Number(port));
  if (authenticated) await signInAnonymously(auth);
  return { auth, firestore, repo: createRuleRepository(auth, firestore),
    async close() { await terminate(firestore); await deleteApp(app); } };
}
function denied(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'permission-denied';
}

test('Auth login → owner save → read/list/update → stale version rejection → metadata delete', { timeout: 60_000 }, async () => {
  const owner = await client();
  try {
    assert.ok(owner.auth.currentUser?.uid);
    assert.equal(await owner.repo.save('my-rules', draft, null), 1);
    const first = await owner.repo.read('my-rules');
    assert.equal(first!.name, '테스트 규칙'); assert.equal(first!.rules[0]!.targetDirectory, '과제/물리');
    assert.ok(first!.updatedAtMillis > 0);
    assert.deepEqual((await owner.repo.list()).map((r) => r.id), ['my-rules']);
    assert.equal(await owner.repo.save('my-rules', { ...draft, name: '수정된 규칙' }, 1), 2);
    await assert.rejects(owner.repo.save('my-rules', draft, 1), RevisionConflict);
    await assert.rejects(owner.repo.save('my-rules', draft, null), RevisionConflict);
    assert.equal((await owner.repo.read('my-rules'))!.name, '수정된 규칙');
    await assert.rejects(owner.repo.remove('my-rules', 1), RevisionConflict);
    await owner.repo.remove('my-rules', 2);
    assert.equal(await owner.repo.read('my-rules'), null);
  } finally { await owner.close(); }
});

test('real Security Rules reject unauthenticated and cross-user reads/writes/deletes', { timeout: 60_000 }, async () => {
  const owner = await client(); const other = await client(); const guest = await client(false);
  try {
    await owner.repo.save('private', draft, null);
    const target = ['users', owner.auth.currentUser!.uid, 'ruleSets', 'private'];
    for (const actor of [other, guest]) {
      const ref = doc(actor.firestore, target.join('/'));
      await assert.rejects(getDocFromServer(ref), denied);
      await assert.rejects(setDoc(ref, { ...draft, revision: 2, updatedAt: serverTimestamp() }), denied);
      await assert.rejects(deleteDoc(ref), denied);
    }
    await assert.rejects(guest.repo.list(), /로그인/u);
    assert.equal((await owner.repo.read('private'))!.revision, 1);
  } finally { await Promise.all([owner.close(), other.close(), guest.close()]); }
});

test('direct SDK writes cannot bypass schema, relative path, timestamp or revision policy', { timeout: 60_000 }, async () => {
  const owner = await client();
  try {
    const ref = doc(owner.firestore, 'users', owner.auth.currentUser!.uid, 'ruleSets', 'invalid');
    const record = { formatVersion: 2, deleted: false, name: draft.name, ruleIds: ['physics-pdf'], revision: 1, updatedAt: serverTimestamp() };
    for (const extra of [{ absolutePath: '/private/test' }, { content: 'private bytes' }, { approval: 'token' }])
      await assert.rejects(setDoc(ref, { ...record, ...extra }), denied);
    async function invalidRule(fields: Record<string, unknown>) {
      const batch = writeBatch(owner.firestore);
      batch.set(ref, record);
      batch.set(doc(ref, 'rules', ruleDocumentId(1, 'physics-pdf')), { ...draft.rules[0], revision: 1, updatedAt: serverTimestamp(), ...fields });
      await assert.rejects(batch.commit(), denied);
    }
    for (const targetDirectory of ['/Users/test', 'C:/Users/test', '../escape', 'a/../b', 'a\\b', 'NUL', 'a/CON.txt', 'a./b'])
      await invalidRule({ targetDirectory });
    await invalidRule({ enabled: 'true' });
    await invalidRule({ content: 'private bytes' });
    await invalidRule({ revision: 2 });
    await assert.rejects(setDoc(ref, { ...record, revision: 2 }), denied);
    await assert.rejects(setDoc(ref, { ...record, updatedAt: null }), denied);
    await assert.rejects(setDoc(ref, { ...record, ruleIds: Array.from({ length: 21 }, (_, i) => `r${i}`) }), denied);
    assert.equal(await owner.repo.read('invalid'), null);
    await owner.repo.save('existing', draft, null);
    await assert.rejects(setDoc(doc(owner.firestore, 'users', owner.auth.currentUser!.uid, 'ruleSets', 'existing'), record), denied);
    assert.equal((await owner.repo.read('existing'))!.revision, 1);
  } finally { await owner.close(); }
});

test('maximum-size rulesets and atomic shrink preserve a consistent readable version', { timeout: 60_000 }, async () => {
  const owner = await client();
  try {
    const full = { ...draft, name: 'AFO rules 2026', rules: Array.from({ length: 20 }, (_, i) => ({ ...draft.rules[0], id: `r${i}`, targetDirectory: 'School/Physics 2026' })) };
    await owner.repo.save('full', full, null);
    assert.equal((await owner.repo.read('full'))!.rules.length, 20);
    assert.equal((await owner.repo.read('full'))!.name, 'AFO rules 2026');
    await owner.repo.save('full', draft, 1);
    assert.equal((await owner.repo.read('full'))!.rules.length, 1);
    const oldChild = doc(owner.firestore, 'users', owner.auth.currentUser!.uid, 'ruleSets', 'full', 'rules', ruleDocumentId(1, 'r19'));
    assert.equal((await getDocFromServer(oldChild)).exists(), false);
  } finally { await owner.close(); }
});

test('Hosting emulator serves the explicitly labeled setup page', async () => {
  const response = await fetch('http://127.0.0.1:15010');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /최종 AFO 웹 서비스가 아닙니다/u);
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/u);
});

test('metadata-only create/update and active child deletion cannot break a published set', { timeout: 60_000 }, async () => {
  const owner = await client();
  try {
    const ref = doc(owner.firestore, 'users', owner.auth.currentUser!.uid, 'ruleSets', 'integrity');
    const metadata = { formatVersion: 2, name: draft.name, deleted: false, ruleIds: ['ghost'], revision: 1, updatedAt: serverTimestamp() };
    await assert.rejects(setDoc(ref, metadata), denied);
    await owner.repo.save('integrity', draft, null);
    await assert.rejects(setDoc(ref, { ...metadata, revision: 2 }), denied);
    const child = doc(ref, 'rules', ruleDocumentId(1, 'physics-pdf'));
    await assert.rejects(deleteDoc(child), denied);
    await assert.rejects(setDoc(child, { ...draft.rules[0], revision: 1, updatedAt: serverTimestamp() }), denied);
    await assert.rejects(deleteDoc(ref), denied);
    assert.equal((await owner.repo.read('integrity'))!.revision, 1);
    assert.deepEqual((await owner.repo.list()).map((r) => r.id), ['integrity']);
    // A batch cannot publish a child and simultaneously delete it.
    const batch = writeBatch(owner.firestore);
    batch.set(ref, { ...metadata, ruleIds: ['physics-pdf'], revision: 2 });
    batch.delete(doc(ref, 'rules', ruleDocumentId(2, 'physics-pdf')));
    await assert.rejects(batch.commit(), denied);
  } finally { await owner.close(); }
});

test('delete/recreate preserves monotonic versions and rejects stale save and remove', { timeout: 60_000 }, async () => {
  const owner = await client();
  try {
    const stale = await owner.repo.save('reused-id', draft, null);
    await owner.repo.remove('reused-id', stale);
    assert.equal(await owner.repo.read('reused-id'), null);
    assert.deepEqual(await owner.repo.list(), []);
    const next = await owner.repo.save('reused-id', { ...draft, name: '새 규칙' }, null);
    assert.ok(next > stale);
    await assert.rejects(owner.repo.save('reused-id', draft, stale), RevisionConflict);
    await assert.rejects(owner.repo.remove('reused-id', stale), RevisionConflict);
    assert.equal((await owner.repo.read('reused-id'))!.name, '새 규칙');
    await owner.repo.remove('reused-id', next);
    const ref = doc(owner.firestore, 'users', owner.auth.currentUser!.uid, 'ruleSets', 'reused-id');
    assert.equal((await getDocFromServer(ref)).data()!['deleted'], true);
    await assert.rejects(setDoc(ref, { formatVersion: 2, deleted: false, name: draft.name,
      ruleIds: [], revision: 1, updatedAt: serverTimestamp() }), denied);
  } finally { await owner.close(); }
});

test('all 20 children must exist; full-size update, cleanup and delete stay within policy limits', { timeout: 60_000 }, async () => {
  const owner = await client();
  try {
    const full = { ...draft, rules: Array.from({ length: 20 }, (_, i) => ({ ...draft.rules[0]!, id: `r${i}` })) };
    const first = await owner.repo.save('twenty', full, null);
    const next = await owner.repo.save('twenty', { ...full, name: '갱신' }, first);
    assert.equal((await owner.repo.read('twenty'))!.rules.length, 20);
    const ref = doc(owner.firestore, 'users', owner.auth.currentUser!.uid, 'ruleSets', 'twenty');
    const incomplete = writeBatch(owner.firestore);
    incomplete.set(ref, { formatVersion: 2, deleted: false, name: draft.name,
      ruleIds: full.rules.map((r) => r.id), revision: next + 1, updatedAt: serverTimestamp() });
    for (const rule of full.rules.slice(0, 19)) incomplete.set(doc(ref, 'rules', ruleDocumentId(next + 1, rule.id)), {
      ...rule, revision: next + 1, updatedAt: serverTimestamp(),
    });
    await assert.rejects(incomplete.commit(), denied);
    assert.equal((await owner.repo.read('twenty'))!.revision, next);
    assert.equal((await getDocFromServer(doc(ref, 'rules', ruleDocumentId(first, 'r19')))).exists(), false);
    await owner.repo.remove('twenty', next);
    assert.equal((await getDocFromServer(doc(ref, 'rules', ruleDocumentId(next, 'r19')))).exists(), false);
    await owner.repo.cleanup('twenty');
    assert.equal(await owner.repo.read('twenty'), null);
  } finally { await owner.close(); }
});

test('concurrent saves cannot publish two updates from one expected revision', { timeout: 60_000 }, async () => {
  const owner = await client();
  try {
    const first = await owner.repo.save('concurrent', draft, null);
    const results = await Promise.allSettled(['one', 'two'].map((name) => owner.repo.save('concurrent', { ...draft, name }, first)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = results.find((r) => r.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof RevisionConflict,
      rejected?.status === 'rejected' ? String(rejected.reason) : 'no rejected save');
    assert.equal((await owner.repo.read('concurrent'))!.revision, first + 1);
  } finally { await owner.close(); }
});

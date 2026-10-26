import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase/app';
import { initializeAuth, inMemoryPersistence, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import { initializeFirestore, connectFirestoreEmulator, doc, setDoc, getDocFromServer, deleteDoc, serverTimestamp, terminate, writeBatch } from 'firebase/firestore';
import { createRuleRepository, RevisionConflict } from '../src/index.js';

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
    const record = { formatVersion: 1, name: draft.name, ruleIds: ['physics-pdf'], revision: 1, updatedAt: serverTimestamp() };
    for (const extra of [{ absolutePath: '/private/test' }, { content: 'private bytes' }, { approval: 'token' }])
      await assert.rejects(setDoc(ref, { ...record, ...extra }), denied);
    async function invalidRule(fields: Record<string, unknown>) {
      const batch = writeBatch(owner.firestore);
      batch.set(ref, record);
      batch.set(doc(ref, 'rules', 'physics-pdf'), { ...draft.rules[0], revision: 1, updatedAt: serverTimestamp(), ...fields });
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
    const oldChild = doc(owner.firestore, 'users', owner.auth.currentUser!.uid, 'ruleSets', 'full', 'rules', 'r19');
    assert.equal((await getDocFromServer(oldChild)).exists(), false);
  } finally { await owner.close(); }
});

test('Hosting emulator serves the explicitly labeled setup page', async () => {
  const response = await fetch('http://127.0.0.1:15010');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /최종 AFO 웹 서비스가 아닙니다/u);
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/u);
});

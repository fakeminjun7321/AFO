import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase/app';
import { initializeAuth, inMemoryPersistence, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import { initializeFirestore, connectFirestoreEmulator, doc, setDoc, deleteDoc, serverTimestamp, terminate } from 'firebase/firestore';
import { createRuleRepository } from '../dist/src/index.js';

assert.equal(process.env.GCLOUD_PROJECT, 'demo-afo-tests');
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:18080');
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:19099');
const draft = { formatVersion: 1, name: 'synthetic review', rules: [
  { id: 'pdf', extension: '.pdf', keyword: null, targetDirectory: 'Documents', enabled: true },
] };
async function client() {
  const app = initializeApp({ projectId: 'demo-afo-tests', apiKey: 'demo-only-key' }, `review-${randomUUID()}`);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  connectAuthEmulator(auth, 'http://127.0.0.1:19099', { disableWarnings: true });
  const firestore = initializeFirestore(app, { experimentalForceLongPolling: true });
  connectFirestoreEmulator(firestore, '127.0.0.1', 18080);
  await signInAnonymously(auth);
  return { auth, firestore, repo: createRuleRepository(auth, firestore),
    async close() { await terminate(firestore); await deleteApp(app); } };
}

test('REPRO: a metadata-only create is accepted and makes repository read/list throw', { timeout: 60000 }, async () => {
  const c = await client();
  try {
    const ref = doc(c.firestore, 'users', c.auth.currentUser.uid, 'ruleSets', 'missing-child');
    await setDoc(ref, { formatVersion: 1, name: draft.name, ruleIds: ['ghost'], revision: 1, updatedAt: serverTimestamp() });
    await assert.rejects(c.repo.read('missing-child'), /누락/);
    await assert.rejects(c.repo.list(), /누락/);
    console.log('REPRO metadata write accepted without child; read/list both failed');
  } finally { await c.close(); }
});

test('REPRO: child delete bypasses revision and leaves a broken rule set', { timeout: 60000 }, async () => {
  const c = await client();
  try {
    await c.repo.save('rules', draft, null);
    await deleteDoc(doc(c.firestore, 'users', c.auth.currentUser.uid, 'ruleSets', 'rules', 'rules', 'pdf'));
    await assert.rejects(c.repo.read('rules'), /누락/);
    console.log('REPRO direct child delete accepted without revision; repository read failed');
  } finally { await c.close(); }
});

test('REPRO: deleting/recreating an ID makes an old revision overwrite new content', { timeout: 60000 }, async () => {
  const c = await client();
  try {
    const staleRevision = await c.repo.save('reused-id', draft, null);
    await c.repo.remove('reused-id', staleRevision);
    await c.repo.save('reused-id', { ...draft, name: 'new generation' }, null);
    assert.equal(await c.repo.save('reused-id', { ...draft, name: 'old client overwrite' }, staleRevision), 2);
    assert.equal((await c.repo.read('reused-id')).name, 'old client overwrite');
    console.log('REPRO stale revision 1 overwrote a recreated ruleset');
  } finally { await c.close(); }
});

import type { Auth } from 'firebase/auth';
import { collection, doc, getDocsFromServer, runTransaction, serverTimestamp, Timestamp } from 'firebase/firestore';
import type { Firestore, DocumentData, DocumentReference } from 'firebase/firestore';
import { CloudRule, RuleSetDraft, RuleSetId, RuleSetMetadata, StoredRuleSet } from './schema.js';
import type { RuleSetRecord } from './schema.js';
export * from './schema.js';

export class RevisionConflict extends Error {
  constructor() { super('클라우드 규칙 버전이 바뀌었습니다. 다시 읽고 확인하세요.'); this.name = 'RevisionConflict'; }
}

function metadata(data: DocumentData) {
  if (!(data['updatedAt'] instanceof Timestamp)) throw new Error('서버 저장 시각이 유효하지 않습니다.');
  const { updatedAt, ...rest } = data;
  return { ...RuleSetMetadata.parse(rest), updatedAtMillis: (updatedAt as Timestamp).toMillis() };
}

/** End-user client SDK only. Security Rules, not this wrapper, enforce tenant isolation. */
export function createRuleRepository(auth: Auth, firestore: Firestore) {
  function namespace() {
    const uid = auth.currentUser?.uid;
    if (!uid || uid.includes('/')) throw new Error('사용자 로그인이 필요합니다.');
    return collection(firestore, 'users', uid, 'ruleSets');
  }
  function reference(id: string) { return doc(namespace(), RuleSetId.parse(id)); }
  async function readReference(ref: DocumentReference): Promise<RuleSetRecord | null> {
    return runTransaction(firestore, async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists()) return null;
      const meta = metadata(snapshot.data());
      const snapshots = await Promise.all(meta.ruleIds.map((id) => transaction.get(doc(ref, 'rules', id))));
      const rules = snapshots.map((s) => {
        if (!s.exists()) throw new Error('클라우드 규칙 문서가 누락됐습니다.');
        const { revision, updatedAt, ...rule } = s.data();
        if (revision !== meta.revision || !(updatedAt instanceof Timestamp)) throw new Error('클라우드 규칙 버전이 일치하지 않습니다.');
        return CloudRule.parse(rule);
      });
      return StoredRuleSet.parse({ formatVersion: meta.formatVersion, name: meta.name,
        revision: meta.revision, updatedAtMillis: meta.updatedAtMillis, rules });
    }, { maxAttempts: 3 });
  }
  return {
    async read(id: string): Promise<RuleSetRecord | null> {
      return readReference(reference(id));
    },
    async list(): Promise<Array<{ id: string; value: RuleSetRecord }>> {
      const snapshots = await getDocsFromServer(namespace());
      const values = await Promise.all(snapshots.docs.map(async (s) => ({ id: s.id, value: await readReference(s.ref) })));
      return values.filter((v): v is { id: string; value: RuleSetRecord } => v.value !== null);
    },
    async save(id: string, input: unknown, expectedRevision: number | null): Promise<number> {
      const parsed = RuleSetDraft.parse(input);
      if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1))
        throw new Error('기준 버전이 유효하지 않습니다.');
      const ref = reference(id);
      return runTransaction(firestore, async (transaction) => {
        const current = await transaction.get(ref);
        const previous = current.exists() ? metadata(current.data()) : null;
        const revision = previous?.revision ?? null;
        if (revision !== expectedRevision) throw new RevisionConflict();
        const next = (revision ?? 0) + 1;
        const ruleIds = parsed.rules.map((rule) => rule.id);
        transaction.set(ref, { formatVersion: parsed.formatVersion, name: parsed.name, ruleIds,
          revision: next, updatedAt: serverTimestamp() });
        for (const id of previous?.ruleIds ?? []) if (!ruleIds.includes(id)) transaction.delete(doc(ref, 'rules', id));
        for (const rule of parsed.rules) transaction.set(doc(ref, 'rules', rule.id), {
          ...rule, revision: next, updatedAt: serverTimestamp(),
        });
        return next;
      }, { maxAttempts: 3 });
    },
    async remove(id: string, expectedRevision: number): Promise<void> {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('기준 버전이 유효하지 않습니다.');
      const ref = reference(id);
      await runTransaction(firestore, async (transaction) => {
        const current = await transaction.get(ref);
        if (!current.exists()) throw new RevisionConflict();
        const previous = metadata(current.data());
        if (previous.revision !== expectedRevision) throw new RevisionConflict();
        for (const id of previous.ruleIds) transaction.delete(doc(ref, 'rules', id));
        transaction.delete(ref);
      }, { maxAttempts: 3 });
    },
  };
}

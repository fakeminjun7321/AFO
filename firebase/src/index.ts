import type { Auth } from 'firebase/auth';
import { collection, doc, getDocFromServer, getDocsFromServer, runTransaction, serverTimestamp, Timestamp, writeBatch } from 'firebase/firestore';
import type { Firestore, DocumentData, DocumentReference, Transaction } from 'firebase/firestore';
import { CloudRule, RuleSetDraft, RuleSetId, RuleSetMetadata, StoredRuleSet } from './schema.js';
import type { RuleSetRecord } from './schema.js';
export * from './schema.js';

export class RevisionConflict extends Error {
  constructor() { super('클라우드 규칙 버전이 바뀌었습니다. 다시 읽고 확인하세요.'); this.name = 'RevisionConflict'; }
}

/** The publish/delete already committed. Only obsolete child cleanup failed; do not retry the old revision. */
export class CleanupPending extends Error {
  constructor(readonly committedRevision: number, options: { cause: unknown }) {
    super('규칙 변경은 저장됐지만 이전 규칙 정리를 마치지 못했습니다. 다시 조회한 뒤 cleanup을 실행하세요.', options);
    this.name = 'CleanupPending';
  }
}

export const ruleDocumentId = (revision: number, id: string): string => `${revision}_${id}`;

function metadata(data: DocumentData) {
  if (data['formatVersion'] !== 2) throw new Error('클라우드 저장 형식 v2가 필요합니다. 기존 v1 자료는 별도 마이그레이션이 필요합니다.');
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
  async function versioned<T>(ref: DocumentReference, expected: number | null, action: (transaction: Transaction) => Promise<T>): Promise<T> {
    try { return await runTransaction(firestore, action, { maxAttempts: 3 }); }
    catch (error) {
      // Immutable child policy can reject a racing commit before the SDK retries its precondition.
      // Re-read only for definite rejected transactions; never retry a mutation or hide an uncertain network result.
      if (error !== null && typeof error === 'object' && 'code' in error &&
          (error.code === 'permission-denied' || error.code === 'aborted')) {
        const current = await getDocFromServer(ref).catch(() => null);
        if (current) {
          const meta = current.exists() ? metadata(current.data()) : null;
          const live = meta && !meta.deleted ? meta.revision : null;
          if (live !== expected) throw new RevisionConflict();
        }
      }
      throw error;
    }
  }
  async function cleanupReference(ref: DocumentReference, beforeRevision: number): Promise<void> {
    const children = await getDocsFromServer(collection(ref, 'rules'));
    const obsolete = children.docs.filter((s) => Number.isSafeInteger(s.data()['revision']) && s.data()['revision'] < beforeRevision);
    // Separate bounded batches keep publish within Firestore's 20-document policy budget.
    for (let i = 0; i < obsolete.length; i += 20) {
      const batch = writeBatch(firestore);
      for (const child of obsolete.slice(i, i + 20)) batch.delete(child.ref);
      await batch.commit();
    }
  }
  async function readReference(ref: DocumentReference): Promise<RuleSetRecord | null> {
    return runTransaction(firestore, async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists()) return null;
      const meta = metadata(snapshot.data());
      if (meta.deleted) return null;
      const snapshots = await Promise.all(meta.ruleIds.map((id) => transaction.get(doc(ref, 'rules', ruleDocumentId(meta.revision, id)))));
      const rules = snapshots.map((s) => {
        if (!s.exists()) throw new Error('클라우드 규칙 문서가 누락됐습니다.');
        const { revision, updatedAt, ...rule } = s.data();
        if (revision !== meta.revision || !(updatedAt instanceof Timestamp)) throw new Error('클라우드 규칙 버전이 일치하지 않습니다.');
        return CloudRule.parse(rule);
      });
      return StoredRuleSet.parse({ formatVersion: 1, name: meta.name,
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
      const next = await versioned(ref, expectedRevision, async (transaction) => {
        const current = await transaction.get(ref);
        const previous = current.exists() ? metadata(current.data()) : null;
        const revision = previous && !previous.deleted ? previous.revision : null;
        if (revision !== expectedRevision) throw new RevisionConflict();
        const next = (previous?.revision ?? 0) + 1;
        if (!Number.isSafeInteger(next)) throw new Error('규칙 버전의 안전한 정수 범위를 넘었습니다.');
        const ruleIds = parsed.rules.map((rule) => rule.id);
        transaction.set(ref, { formatVersion: 2, name: parsed.name, ruleIds, deleted: false,
          revision: next, updatedAt: serverTimestamp() });
        for (const rule of parsed.rules) transaction.set(doc(ref, 'rules', ruleDocumentId(next, rule.id)), {
          ...rule, revision: next, updatedAt: serverTimestamp(),
        });
        return next;
      });
      try { await cleanupReference(ref, next); }
      catch (cause) { throw new CleanupPending(next, { cause }); }
      return next;
    },
    async remove(id: string, expectedRevision: number): Promise<void> {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('기준 버전이 유효하지 않습니다.');
      const ref = reference(id);
      const next = await versioned(ref, expectedRevision, async (transaction) => {
        const current = await transaction.get(ref);
        if (!current.exists()) throw new RevisionConflict();
        const previous = metadata(current.data());
        if (previous.deleted || previous.revision !== expectedRevision) throw new RevisionConflict();
        const next = previous.revision + 1;
        if (!Number.isSafeInteger(next)) throw new Error('규칙 버전의 안전한 정수 범위를 넘었습니다.');
        transaction.set(ref, { formatVersion: 2, name: 'deleted', deleted: true, ruleIds: [],
          revision: next, updatedAt: serverTimestamp() });
        return next;
      });
      try { await cleanupReference(ref, next); }
      catch (cause) { throw new CleanupPending(next, { cause }); }
    },
    /** Retry cleanup after CleanupPending; current/newer generations are never removed. */
    async cleanup(id: string): Promise<void> {
      const ref = reference(id);
      const current = await runTransaction(firestore, (transaction) => transaction.get(ref), { maxAttempts: 3 });
      if (current.exists()) await cleanupReference(ref, metadata(current.data()).revision);
    },
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { RuleSetDraft, RuleSetId, RuleSetMetadata } from '../src/schema.js';

const valid = { formatVersion: 1, name: '개인 분류', rules: [
  { id: 'physics-pdf', extension: '.pdf', keyword: '물리', targetDirectory: '과제/물리', enabled: true },
] };

test('portable rule data is accepted without filesystem authority', () => {
  assert.deepEqual(RuleSetDraft.parse(valid), valid);
});
test('local profiles, reference filenames, content and approval tokens are rejected', () => {
  for (const field of ['referenceRoot', 'referenceFiles', 'content', 'approval', 'absolutePath', 'status'])
    assert.equal(RuleSetDraft.safeParse({ ...valid, [field]: 'private data' }).success, false, field);
  assert.equal(RuleSetDraft.safeParse({ ...valid, rules: [{ ...valid.rules[0], evidence: ['a.pdf', 'b.pdf'] }] }).success, false);
});
test('unsafe destinations cannot enter the cloud contract', () => {
  for (const targetDirectory of ['/Users/test', 'C:/Users/test', '../escape', 'a/../b', 'a\\b', 'a//b', 'NUL', 'a/CON.txt', 'a./b', 'a/'])
    assert.equal(RuleSetDraft.safeParse({ ...valid, rules: [{ ...valid.rules[0], targetDirectory }] }).success, false, targetDirectory);
});
test('wrong types, repeated IDs and excessive rule counts fail closed', () => {
  assert.equal(RuleSetDraft.safeParse({ ...valid, rules: [{ ...valid.rules[0], enabled: 'true' }] }).success, false);
  assert.equal(RuleSetDraft.safeParse({ ...valid, rules: [valid.rules[0], valid.rules[0]] }).success, false);
  assert.equal(RuleSetDraft.safeParse({ ...valid, rules: Array.from({ length: 21 }, (_, i) => ({ ...valid.rules[0], id: `r${i}` })) }).success, false);
});
test('document identifiers cannot introduce another path', () => {
  for (const id of ['../other', 'users/u', '', 'a b']) assert.equal(RuleSetId.safeParse(id).success, false);
});

test('v2 tombstones preserve a version without retaining rule names or references; v1 is not silently accepted', () => {
  const metadata = { formatVersion: 2, name: 'deleted', deleted: true, revision: 2, ruleIds: [] };
  assert.equal(RuleSetMetadata.safeParse(metadata).success, true);
  assert.equal(RuleSetMetadata.safeParse({ ...metadata, formatVersion: 1 }).success, false);
  assert.equal(RuleSetMetadata.safeParse({ ...metadata, ruleIds: ['r1'] }).success, false);
});

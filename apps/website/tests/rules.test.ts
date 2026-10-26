import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyRules,
  parseRules,
  readLocal,
  storageKey,
  writeLocal,
} from "../src/features/rules/local.ts";

const valid = {
  formatVersion: 1,
  name: "학교 규칙",
  rules: [
    {
      id: "pdf",
      extension: ".pdf",
      keyword: "물리",
      targetDirectory: "학교/물리",
      enabled: true,
    },
  ],
};
test("portable rules roundtrip and account namespaces stay separate", () => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
  writeLocal(storage, storageKey("a"), valid);
  assert.deepEqual(readLocal(storage, storageKey("a")), valid);
  assert.deepEqual(readLocal(storage, storageKey("b")), emptyRules());
  assert.deepEqual(readLocal(storage, storageKey()), emptyRules());
});
test("path escapes, local profile fields, duplicate ids and unsupported versions are refused before saving", () => {
  for (const directory of [
    "/Users/person",
    "../outside",
    "C:\\private",
    "학교/../비밀",
    "CON",
    "문서.",
  ]) {
    assert.throws(() =>
      parseRules(
        JSON.stringify({
          ...valid,
          rules: [{ ...valid.rules[0], targetDirectory: directory }],
        }),
      ),
    );
  }
  assert.throws(() =>
    parseRules(JSON.stringify({ ...valid, root: "/private" })),
  );
  assert.throws(() =>
    parseRules(
      JSON.stringify({ ...valid, rules: [valid.rules[0], valid.rules[0]] }),
    ),
  );
  assert.throws(() =>
    parseRules(JSON.stringify({ ...valid, formatVersion: 2 })),
  );
});
test("corrupt/oversized input and storage failures never overwrite previous data", () => {
  assert.throws(() => parseRules("{"));
  assert.throws(() => parseRules(" ".repeat(65537)));
  assert.throws(() => parseRules("한".repeat(22000)));
  assert.throws(
    () =>
      writeLocal(
        {
          setItem() {
            throw new Error("quota");
          },
        },
        "a",
        valid,
      ),
    /quota/,
  );
  const storage = { getItem: () => "{invalid" };
  assert.throws(() => readLocal(storage, "a"));
  assert.equal(storage.getItem(), "{invalid");
});

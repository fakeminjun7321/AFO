import { test } from "node:test";
import assert from "node:assert/strict";
import { requireAdmin, publicUser, parsePageToken } from "../src/access.js";
test("unauthenticated, ordinary, unverified and string-valued claims never authorize", () => {
  for (const value of [
    undefined,
    { token: {} },
    { token: { admin: true, email_verified: false } },
    { token: { admin: "true", email_verified: true } },
  ])
    assert.throws(() => requireAdmin(value));
  assert.doesNotThrow(() =>
    requireAdmin({ token: { admin: true, email_verified: true } }),
  );
});
test("response allowlist never leaks hashes, salts, refresh tokens or arbitrary claims", () => {
  const user = {
    uid: "one",
    email: "one@example.invalid",
    emailVerified: true,
    disabled: false,
    metadata: { creationTime: "date" },
    providerData: [{ providerId: "google.com" }],
    passwordHash: "PRIVATE",
    passwordSalt: "PRIVATE",
    tokensValidAfterTime: "PRIVATE",
    customClaims: { private: "PRIVATE" },
  };
  const result = publicUser(user);
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  assert.equal(result.email, user.email);
  assert.deepEqual(Object.keys(result).sort(), [
    "createdAt",
    "disabled",
    "displayName",
    "email",
    "emailVerified",
    "lastSignInAt",
    "providers",
    "uid",
  ]);
});
test("pagination rejects oversized and non-string input", () => {
  assert.throws(() => parsePageToken({ pageToken: "x".repeat(2049) }));
  assert.throws(() => parsePageToken({ pageToken: { x: 1 } }));
  assert.equal(parsePageToken({ pageToken: "next" }), "next");
});

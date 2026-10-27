export class AccessDenied extends Error {}
export function requireAdmin(
  auth: { token: Record<string, unknown> } | undefined,
) {
  if (!auth || auth.token.admin !== true || auth.token.email_verified !== true)
    throw new AccessDenied("Verified administrator required");
}
export function parsePageToken(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  const value = (input as Record<string, unknown>).pageToken;
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 2048 ||
    /[\x00-\x1f]/.test(value)
  )
    throw new Error("Invalid page token");
  return value;
}
export function publicUser(user: {
  uid: string;
  email?: string;
  displayName?: string;
  emailVerified: boolean;
  disabled: boolean;
  metadata: { creationTime?: string; lastSignInTime?: string };
  providerData: { providerId: string }[];
}) {
  return {
    uid: user.uid,
    email: user.email ?? null,
    displayName: user.displayName ?? null,
    emailVerified: user.emailVerified,
    disabled: user.disabled,
    createdAt: user.metadata.creationTime ?? null,
    lastSignInAt: user.metadata.lastSignInTime ?? null,
    providers: user.providerData.map((p) => p.providerId),
  };
}

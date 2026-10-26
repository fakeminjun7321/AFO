import { createHash } from 'node:crypto';

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
/** Case- and Unicode-insensitive comparison key, matching default macOS/Windows file systems. */
export const pathKey = (value: string): string => value.normalize('NFC').toLowerCase();
export const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

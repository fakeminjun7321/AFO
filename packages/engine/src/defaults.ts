/** Default rules for CLASSIFICATION_VERSION. Edit together with the version. */
export const categoryExtensions: Readonly<Record<string, readonly string[]>> = {
  '문서': ['pdf', 'hwp', 'hwpx', 'doc', 'docx', 'txt', 'md', 'odt', 'ppt', 'pptx', 'xls', 'xlsx', 'csv'],
  '이미지': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg', 'tif', 'tiff'],
  '영상': ['mp4', 'mov', 'mkv', 'avi', 'webm'], '음악': ['mp3', 'wav', 'flac', 'm4a', 'ogg'],
  '압축': ['zip', '7z', 'rar', 'tar', 'gz'], '설치': ['dmg', 'pkg', 'exe', 'msi'],
};
const known = new Map(Object.entries(categoryExtensions).flatMap(([category, exts]) => exts.map((ext) => [ext, category] as const)));
/** Extension of a file name (not a path), matching Node's posix.extname. */
export function extensionOfName(name: string): string {
  const index = name.lastIndexOf('.');
  return index <= 0 || name === '..' ? '' : name.slice(index).toLowerCase();
}
export function defaultCategory(name: string): { category: string | null; reason: 'NO_EXTENSION' | 'COMPOUND_EXTENSION' | 'UNKNOWN_EXTENSION' | 'DEFAULT_EXTENSION' } {
  const ext = extensionOfName(name);
  if (!ext) return { category: null, reason: 'NO_EXTENSION' };
  const inner = extensionOfName(name.slice(0, -ext.length)).slice(1);
  if (inner && known.has(inner)) return { category: null, reason: 'COMPOUND_EXTENSION' };
  const category = known.get(ext.slice(1));
  return category ? { category, reason: 'DEFAULT_EXTENSION' } : { category: null, reason: 'UNKNOWN_EXTENSION' };
}

/**
 * Default rules for CLASSIFICATION_VERSION. Edit together with the version. One extension belongs to one category only.
 * Left out on purpose (still "확인 필요"): ts (TypeScript or MPEG-TS), m (Objective-C or MATLAB), bin, dat, tmp, lnk, url, webloc, alias.
 */
export const categoryExtensions: Readonly<Record<string, readonly string[]>> = {
  '문서': ['pdf', 'hwp', 'hwpx', 'doc', 'docx', 'txt', 'md', 'odt', 'ppt', 'pptx', 'xls', 'xlsx', 'csv', 'rtf', 'key', 'pages', 'numbers',
    'odp', 'ods', 'tex', 'hwt', 'show', 'cell', 'xlsm', 'docm', 'pptm', 'keynote', 'one', 'xps'],
  '이미지': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg', 'tif', 'tiff', 'bmp', 'ico', 'avif', 'jfif', 'raw', 'cr2', 'cr3', 'nef',
    'arw', 'dng', 'orf', 'rw2', 'heif', 'jxl'],
  // Subtitles go with the videos they belong to.
  '영상': ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'wmv', 'flv', '3gp', 'mpg', 'mpeg', 'vob', 'mts', 'm2ts', 'srt', 'smi', 'ass', 'vtt'],
  '음악': ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'wma', 'aiff', 'aif', 'opus', 'mid', 'midi', 'amr', 'alac', 'ape'],
  '압축': ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz', 'lzma', 'cab', 'alz', 'egg', 'tbz', 'txz'],
  '설치': ['dmg', 'pkg', 'exe', 'msi', 'apk', 'deb', 'rpm', 'appimage', 'iso', 'msix', 'appx', 'xapk'],
  '디자인': ['psd', 'ai', 'sketch', 'fig', 'xd', 'indd', 'afdesign', 'afphoto', 'procreate', 'blend', 'obj', 'fbx', 'stl'],
  '글꼴': ['ttf', 'otf', 'woff', 'woff2', 'ttc'],
  '전자책': ['epub', 'mobi', 'azw', 'azw3'],
  '코드': ['py', 'ipynb', 'js', 'mjs', 'jsx', 'tsx', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'kt', 'go', 'rs', 'rb', 'php', 'html',
    'htm', 'css', 'scss', 'sh', 'bat', 'ps1', 'r'],
  '데이터': ['json', 'xml', 'yaml', 'yml', 'toml', 'sql', 'db', 'sqlite', 'sqlite3', 'parquet', 'tsv', 'log'],
};
/** Browser download in progress (or left unfinished): never moved by default, whatever the inner extension says. */
export const incompleteDownloadExtensions: readonly string[] = ['part', 'crdownload', 'download'];
/** ".tar.<x>" is one archive format, not an ambiguous double extension. */
const tarCompressions = new Set(['gz', 'bz2', 'xz', 'zst', 'lz', 'lzma']);
const known = new Map(Object.entries(categoryExtensions).flatMap(([category, exts]) => exts.map((ext) => [ext, category] as const)));
const incomplete = new Set(incompleteDownloadExtensions);
/** Extension of a file name (not a path), matching Node's posix.extname. */
export function extensionOfName(name: string): string {
  const index = name.lastIndexOf('.');
  return index <= 0 || name === '..' ? '' : name.slice(index).toLowerCase();
}
export type DefaultReason = 'NO_EXTENSION' | 'INCOMPLETE_DOWNLOAD' | 'COMPOUND_EXTENSION' | 'UNKNOWN_EXTENSION' | 'DEFAULT_EXTENSION';
export function defaultCategory(name: string): { category: string | null; reason: DefaultReason } {
  const ext = extensionOfName(name);
  if (!ext) return { category: null, reason: 'NO_EXTENSION' };
  if (incomplete.has(ext.slice(1))) return { category: null, reason: 'INCOMPLETE_DOWNLOAD' };
  const inner = extensionOfName(name.slice(0, -ext.length)).slice(1);
  // "report.pdf.exe": two known type extensions make the real type ambiguous.
  if (inner && known.has(inner) && !(inner === 'tar' && tarCompressions.has(ext.slice(1)))) return { category: null, reason: 'COMPOUND_EXTENSION' };
  const category = known.get(ext.slice(1));
  return category ? { category, reason: 'DEFAULT_EXTENSION' } : { category: null, reason: 'UNKNOWN_EXTENSION' };
}

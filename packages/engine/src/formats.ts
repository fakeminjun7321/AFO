export const plainTextExtensions = ['txt', 'text', 'md', 'markdown', 'mdown', 'mkd', 'rst', 'adoc', 'org', 'tex', 'bib', 'typ', 'rtf',
  'html', 'htm', 'xhtml', 'xml', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'csv', 'tsv', 'log', 'sql',
  'ipynb', 'py', 'js', 'mjs', 'cjs', 'jsx', 'tsx', 'java', 'c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx', 'cs', 'swift', 'kt',
  'kts', 'go', 'rs', 'rb', 'php', 'css', 'scss', 'less', 'sh', 'zsh', 'bash', 'fish', 'ps1', 'bat', 'cmd', 'r', 'jl', 'lua', 'pl',
  'pm', 'dart', 'scala', 'groovy', 'vue', 'svelte', 'astro', 'srt', 'smi', 'ass', 'vtt'];
export const xmlDocumentExtensions = ['docx', 'docm', 'dotx', 'dotm', 'pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm',
  'xlsx', 'xlsm', 'xltx', 'xltm', 'hwpx', 'odt', 'odp', 'ods', 'epub', 'fb2', 'fodt', 'fodp', 'fods'];
export const photoExtensions = ['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'apng', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif',
  'webp', 'ico', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'raf', 'pef', 'sr2', 'nrw'];

export const additionalExtensions: Record<string, string[]> = {
  '문서': ['text', 'markdown', 'mdown', 'mkd', 'rst', 'adoc', 'org', 'bib', 'typ', 'xhtml', 'dot', 'dotx', 'dotm', 'docb',
    'xlt', 'xltx', 'xltm', 'xlsb', 'xla', 'xlam', 'pps', 'ppsx', 'ppsm', 'pot', 'potx', 'potm', 'wps', 'wpd', 'abw',
    'sxw', 'sxi', 'sxc', 'fodt', 'fodp', 'fods', 'djvu', 'djv', 'oxps', 'nb', 'nbp'],
  '이미지': ['jpe', 'jif', 'pjpeg', 'pjp', 'apng', 'xbm', 'xpm', 'pnm', 'pbm', 'pgm', 'ppm', 'pfm', 'hdr', 'exr', 'dds',
    'tga', 'pcx', 'icns', 'cur', 'ani', 'crw', 'sr2', 'srf', 'pef', 'raf', 'rwl', '3fr', 'fff', 'iiq', 'k25', 'kdc', 'mos', 'mrw', 'nrw'],
  '영상': ['m2v', 'mpe', 'mpeg4', 'ogv', 'ogm', '3g2', 'mxf', 'asf', 'rm', 'rmvb', 'divx', 'f4v', 'qt', 'r3d'],
  '음악': ['aif', 'aifc', 'au', 'snd', 'caf', 'mka', 'mp2', 'mpga', 'wv', 'tta', 'tak', 'dsf', 'dff', 'm4b', 'ac3', 'dts', 'ra', 'weba'],
  '압축': ['lz4', 'br', 'lzh', 'lha', 'arj', 'ace', 'cbr', 'cbz', 'cb7', 'zpaq', 'sit', 'sitx', 'tbz2', 'whl', 'jar', 'war', 'ear', 'z'],
  '설치': ['ipa', 'msixbundle', 'appxbundle', 'appinstaller', 'run', 'com', 'scr'],
  '디자인': ['xcf', 'kra', 'ora', 'eps', 'cdr', 'svgz', 'gltf', 'glb', 'usd', 'usda', 'usdc', 'usdz', 'dae', '3ds', 'skp',
    'dwg', 'dxf', 'step', 'stp', 'iges', 'igs', 'gcode', '3mf', 'unitypackage'],
  '글꼴': ['eot', 'bdf', 'pcf', 'otc'], '전자책': ['kfx', 'fb2', 'fb3', 'lit'],
  '코드': ['cjs', 'cc', 'cxx', 'hh', 'hxx', 'kts', 'less', 'zsh', 'bash', 'fish', 'cmd', 'vbs', 'vb', 'fs', 'fsx', 'scala',
    'dart', 'erl', 'ex', 'exs', 'clj', 'cljs', 'cljc', 'jl', 'lua', 'pl', 'pm', 'groovy', 'vue', 'svelte', 'astro', 'graphql', 'gql', 'proto', 'wasm'],
  '데이터': ['jsonl', 'ndjson', 'ini', 'cfg', 'conf', 'edn', 'gpx', 'kml', 'geojson', 'avro', 'orc', 'feather', 'arrow', 'hdf', 'h5',
    'hdf5', 'nc', 'mat', 'pkl', 'pickle', 'npy', 'npz', 'fits', 'fit', 'fts', 'cap', 'dcm'],
};

export function readerFormats(): { extensions: string[]; method: string; note: string }[] {
  return [
    { extensions: plainTextExtensions, method: 'text', note: 'UTF-8·BOM 있는 UTF-16·EUC-KR. 바이너리/해독 실패는 표시합니다.' },
    { extensions: xmlDocumentExtensions.filter((x) => !['fb2', 'fodt', 'fodp', 'fods'].includes(x)), method: 'office-xml', note: '압축된 본문 XML을 추출합니다. 매크로를 실행하지 않습니다.' },
    { extensions: ['fb2', 'fodt', 'fodp', 'fods'], method: 'xml', note: 'XML의 텍스트 내용을 추출합니다.' },
    { extensions: ['pdf'], method: 'pdf', note: '내장 텍스트 추출. 이미지 PDF는 --ocr와 사용 가능한 OS OCR이 필요합니다.' },
    { extensions: photoExtensions, method: 'os-image', note: '촬영일은 저장된 EXIF만 사용. 픽셀·OCR은 OS 코덱/언어 지원에 따라 달라지며 실패를 보고합니다.' },
  ];
}

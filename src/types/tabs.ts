// Full 35-format taxonomy preserved from the Electron codebase so copied
// components/handlers keep compiling. Only PDF has a registered handler
// in v1 — see DEFERRED_FORMATS.md for what lands in v1.1+.

export type DocumentFormat =
  | 'pdf'
  | 'image'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'markdown'
  | 'code'
  | 'csv'
  | 'rtf'
  | 'epub'
  | 'html'
  | 'plaintext'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'xml'
  | 'log'
  | 'diff'
  | 'ini'
  | 'bib'
  | 'tex'
  | 'archive'
  | 'fb2'
  | 'email'
  | 'mbox'
  | 'svg'
  | 'tiff'
  | 'heic'
  | 'sqlite'
  | 'jupyter'
  | 'cert'
  | 'subtitle'
  | 'font'
  | 'djvu'
  | 'mobi'

export interface TabDescriptor {
  id: string
  filePath: string | null
  fileName: string
  format: DocumentFormat
  isDirty: boolean
}

export const FORMAT_ICONS: Record<DocumentFormat, string> = {
  pdf: '📄', image: '🖼', docx: '📝', xlsx: '📊', pptx: '📽',
  markdown: '📑', code: '💻', csv: '📋', rtf: '📃', epub: '📖',
  html: '🌐', plaintext: '📝',
  json: '{}', yaml: '⚙', toml: '⚙', xml: '</>', log: '📜',
  diff: '±', ini: '⚙', bib: '📚', tex: 'ƒ', archive: '🗜',
  fb2: '📖', email: '✉', mbox: '📬', svg: '🎨', tiff: '🖼',
  heic: '🖼', sqlite: '🗃', jupyter: '📓', cert: '🔐',
  subtitle: '💬', font: 'A', djvu: '📄', mobi: '📖',
}

export const FORMAT_NAMES: Record<DocumentFormat, string> = {
  pdf: 'PDF', image: 'Image', docx: 'Word Document', xlsx: 'Spreadsheet',
  pptx: 'Presentation', markdown: 'Markdown', code: 'Code', csv: 'CSV',
  rtf: 'Rich Text', epub: 'eBook', html: 'HTML', plaintext: 'Plain Text',
  json: 'JSON', yaml: 'YAML', toml: 'TOML', xml: 'XML',
  log: 'Log File', diff: 'Diff/Patch', ini: 'Config File',
  bib: 'BibTeX', tex: 'LaTeX', archive: 'Archive', fb2: 'FictionBook',
  email: 'Email', mbox: 'Mailbox', svg: 'SVG', tiff: 'TIFF',
  heic: 'HEIC', sqlite: 'SQLite DB', jupyter: 'Jupyter Notebook',
  cert: 'Certificate', subtitle: 'Subtitles', font: 'Font File',
  djvu: 'DjVu', mobi: 'Mobi eBook',
}

const EXTENSION_MAP: Record<string, DocumentFormat> = {
  '.pdf': 'pdf',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image',
  '.bmp': 'image', '.webp': 'image', '.ico': 'image',
  '.docx': 'docx', '.doc': 'docx',
  '.xlsx': 'xlsx', '.xls': 'xlsx',
  '.pptx': 'pptx', '.ppt': 'pptx',
  '.md': 'markdown', '.markdown': 'markdown', '.mdx': 'markdown',
  '.js': 'code', '.ts': 'code', '.jsx': 'code', '.tsx': 'code',
  '.py': 'code', '.rb': 'code', '.go': 'code', '.rs': 'code',
  '.java': 'code', '.c': 'code', '.cpp': 'code', '.h': 'code',
  '.cs': 'code', '.php': 'code', '.swift': 'code', '.kt': 'code',
  '.sh': 'code', '.bash': 'code', '.zsh': 'code', '.ps1': 'code',
  '.sql': 'code', '.r': 'code', '.lua': 'code', '.perl': 'code',
  '.css': 'code', '.scss': 'code', '.less': 'code',
  '.vue': 'code', '.svelte': 'code',
  '.dockerfile': 'code', '.makefile': 'code',
  '.bat': 'code', '.cmd': 'code',
  '.csv': 'csv', '.tsv': 'csv',
  '.rtf': 'rtf',
  '.epub': 'epub',
  '.fb2': 'fb2',
  '.mobi': 'mobi', '.azw3': 'mobi', '.azw': 'mobi',
  '.html': 'html', '.htm': 'html', '.xhtml': 'html',
  '.txt': 'plaintext', '.cfg': 'plaintext', '.properties': 'plaintext', '.readme': 'plaintext',
  '.json': 'json', '.jsonc': 'json', '.json5': 'json', '.jsonl': 'json', '.ndjson': 'json',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.log': 'log',
  '.diff': 'diff', '.patch': 'diff',
  '.ini': 'ini', '.env': 'ini', '.conf': 'ini',
  '.bib': 'bib', '.bibtex': 'bib',
  '.tex': 'tex', '.latex': 'tex', '.ltx': 'tex',
  '.zip': 'archive', '.tar': 'archive', '.tgz': 'archive', '.tar.gz': 'archive',
  '.gz': 'archive', '.7z': 'archive', '.rar': 'archive', '.bz2': 'archive',
  '.eml': 'email', '.msg': 'email',
  '.mbox': 'mbox',
  '.svg': 'svg',
  '.tiff': 'tiff', '.tif': 'tiff',
  '.heic': 'heic', '.heif': 'heic',
  '.sqlite': 'sqlite', '.db': 'sqlite', '.sqlite3': 'sqlite',
  '.ipynb': 'jupyter',
  '.pem': 'cert', '.crt': 'cert', '.cer': 'cert', '.p12': 'cert',
  '.pfx': 'cert', '.key': 'cert', '.asc': 'cert',
  '.srt': 'subtitle', '.vtt': 'subtitle', '.ass': 'subtitle', '.ssa': 'subtitle',
  '.ttf': 'font', '.otf': 'font', '.woff': 'font', '.woff2': 'font',
  '.djvu': 'djvu', '.djv': 'djvu',
}

export function detectFormat(filePath: string): DocumentFormat {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.tar.gz')) return 'archive'
  const ext = '.' + lower.split('.').pop()
  return EXTENSION_MAP[ext] || 'plaintext'
}

export function getAllSupportedExtensions(): string[] {
  return Object.keys(EXTENSION_MAP).map((ext) => ext.slice(1))
}

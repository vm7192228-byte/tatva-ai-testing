const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_SELECTED_FILES = 24;
const MAX_FILE_UNCOMPRESSED_BYTES = 512 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 3 * 1024 * 1024;
const MAX_PROJECT_CONTEXT_CHARS = 42_000;
const MAX_BUNDLE_FILES = 60;
const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

const CODE_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
  ".css", ".scss", ".sass", ".less", ".html", ".htm", ".vue", ".svelte", ".astro",
  ".json", ".md", ".mdx", ".txt", ".yaml", ".yml", ".toml", ".xml",
  ".py", ".pyi", ".java", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cs",
  ".php", ".rb", ".swift", ".kt", ".kts", ".sql", ".sh", ".bash", ".zsh",
  ".ps1", ".bat", ".cmd", ".graphql", ".gql", ".prisma", ".gradle", ".csv", ".tsv",
  ".dockerfile", ".conf", ".ini", ".properties", ".env.example", ".gitignore"
]);

const SKIP_DIRS = new Set([
  ".git", ".svn", ".hg", "node_modules", "vendor", "dist", "build",
  "coverage", ".next", ".nuxt", ".output", ".turbo", ".cache",
  ".vercel", ".idea", ".vscode", "__pycache__", ".pytest_cache"
]);

const SKIP_FILES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock",
  "bun.lockb", "composer.lock", "poetry.lock", "cargo.lock",
  "gemfile.lock", "pipfile.lock"
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

function fail(message) {
  throw new Error(message);
}

function safeArchivePath(rawPath) {
  if (!rawPath || rawPath.includes("\0")) return undefined;
  const normalized = rawPath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return undefined;
  const segments = normalized.split("/").filter(Boolean);
  if (!segments.length || segments.some(part => part === "." || part === "..")) return undefined;
  if (segments.some(part => SKIP_DIRS.has(part.toLowerCase()))) return "";
  const filename = segments[segments.length - 1].toLowerCase();
  if (
    filename === ".env" ||
    (filename.startsWith(".env.") && ![".env.example", ".env.sample", ".env.template"].includes(filename)) ||
    filename.endsWith(".pem") ||
    filename.endsWith(".key") ||
    filename.endsWith(".p12") ||
    filename.endsWith(".pfx") ||
    filename === ".npmrc" ||
    filename === ".pypirc" ||
    filename.includes("credentials") ||
    filename.includes("secret")
  ) return "";
  return segments.join("/");
}

function extensionOf(path) {
  const name = path.split("/").pop().toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return ".dockerfile";
  if (name === ".gitignore") return ".gitignore";
  if (name === ".env.example") return ".env.example";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

function shouldReadPath(path, allowedExtensions) {
  const normalized = path.toLowerCase();
  const base = normalized.split("/").pop();
  if (SKIP_FILES.has(base)) return false;
  const extension = extensionOf(normalized);
  return allowedExtensions ? allowedExtensions.has(extension) : CODE_EXTENSIONS.has(extension);
}

function getCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[n] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = getCrcTable();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readZipDirectory(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const lowerBound = Math.max(0, bytes.length - 65_557);
  let eocd = -1;

  for (let offset = bytes.length - 22; offset >= lowerBound; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === bytes.length) {
        eocd = offset;
        break;
      }
    }
  }

  if (eocd < 0) fail("This ZIP file is incomplete or has an invalid directory.");
  const diskNumber = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);

  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== totalEntries) {
    fail("Multi-disk ZIP archives are not supported. Please create a standard single-part ZIP.");
  }
  if (totalEntries > MAX_ARCHIVE_ENTRIES) {
    fail("This archive has too many entries to inspect safely. Exclude dependency folders such as node_modules and try again.");
  }
  if (directoryOffset + directorySize > eocd) fail("The ZIP directory is outside the archive.");

  const entries = [];
  const seen = new Set();
  let cursor = directoryOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > eocd || view.getUint32(cursor, true) !== 0x02014b50) {
      fail("The ZIP directory contains an invalid entry.");
    }

    const madeBy = view.getUint16(cursor + 4, true);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const expectedCrc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;

    if (recordEnd > eocd) fail("A ZIP entry has an invalid directory record.");
    if (flags & 0x0041) fail("Encrypted ZIP entries cannot be analyzed or updated. Upload an unencrypted archive.");
    if ((madeBy >>> 8) === 3) {
      const unixType = (externalAttributes >>> 16) & 0xf000;
      if (unixType === 0xa000) fail("Symbolic links are not accepted in project archives.");
    }

    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    let rawName;
    try {
      rawName = (flags & 0x0800)
        ? new TextDecoder("utf-8", { fatal: true }).decode(nameBytes)
        : new TextDecoder("windows-1252").decode(nameBytes);
    } catch {
      fail("A ZIP filename uses an invalid character encoding.");
    }

    const isDirectory = rawName.endsWith("/") || rawName.endsWith("\\");
    const safePath = safeArchivePath(rawName);
    if (safePath === undefined) fail("The archive contains an unsafe path. Remove absolute paths or entries containing dot-dot path segments.");
    if (safePath && !isDirectory) {
      const key = safePath.toLowerCase();
      if (seen.has(key)) fail("The archive contains duplicate filenames after path normalization.");
      seen.add(key);
      entries.push({
        path: safePath,
        flags,
        method,
        expectedCrc,
        compressedSize,
        uncompressedSize,
        localOffset,
        madeBy,
        versionNeeded: view.getUint16(cursor + 6, true),
        externalAttributes,
        modifiedTime: view.getUint16(cursor + 12, true),
        modifiedDate: view.getUint16(cursor + 14, true)
      });
    }

    cursor = recordEnd;
  }

  return { view, bytes, entries, totalEntries, directoryOffset };
}

export async function readBoundedStream(stream, maxBytes) {
  const reader = stream.getReader();
  // Allocate only the declared size, already capped to MAX_FILE_UNCOMPRESSED_BYTES.
  // This avoids retaining an unbounded number of tiny decompressor chunks.
  const output = new Uint8Array(maxBytes);
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        fail("A ZIP decompressor returned an invalid byte stream.");
      }
      if (value.byteLength > maxBytes - totalBytes) {
        try { await reader.cancel(); } catch { /* The decompressor may already be closed. */ }
        throw new Error("ZIP_ENTRY_EXPANSION_LIMIT");
      }
      output.set(value, totalBytes);
      totalBytes += value.byteLength;
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the original decompression error. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }

  return output.slice(0, totalBytes);
}

async function decompressEntry(archive, entry) {
  if (entry.uncompressedSize > MAX_FILE_UNCOMPRESSED_BYTES) return null;
  if (entry.compressedSize > archive.bytes.length || entry.localOffset + 30 > archive.bytes.length) {
    fail("A ZIP entry points outside the archive.");
  }

  const view = archive.view;
  const offset = entry.localOffset;
  if (view.getUint32(offset, true) !== 0x04034b50) fail("A ZIP local file header is invalid.");
  const localFlags = view.getUint16(offset + 6, true);
  const localMethod = view.getUint16(offset + 8, true);
  const filenameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataOffset = offset + 30 + filenameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;

  if (localFlags & 0x0001) fail("Password-protected ZIP entries cannot be analyzed.");
  if (localMethod !== entry.method || dataEnd > archive.bytes.length) fail("A ZIP entry header does not match its directory record.");
  if (entry.method !== 0 && entry.method !== 8) return null;

  if ((localFlags & 0x0041) || localFlags !== entry.flags) fail("A ZIP local header uses unsupported or inconsistent flags.");
  const localNameBytes = archive.bytes.subarray(offset + 30, offset + 30 + filenameLength);
  const localName = (localFlags & 0x0800)
    ? new TextDecoder("utf-8", { fatal: true }).decode(localNameBytes)
    : new TextDecoder("windows-1252").decode(localNameBytes);
  if (localName.replace(/\\/g, "/") !== entry.path) fail("A ZIP local filename does not match its central directory entry.");
  const compressed = archive.bytes.subarray(dataOffset, dataEnd);
  let result;
  if (entry.method === 0) {
    if (compressed.byteLength > Math.min(entry.uncompressedSize, MAX_FILE_UNCOMPRESSED_BYTES)) {
      fail("A ZIP entry contains more stored bytes than its declared or allowed size.");
    }
    result = compressed.slice();
  } else {
    if (typeof DecompressionStream === "undefined") {
      fail("This browser cannot decompress ZIP files. Update your browser or upload the extracted source files.");
    }
    try {
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      // Trust neither the ZIP directory size nor the decompressor output. Stop
      // reading immediately if the actual output exceeds the declared size or
      // the per-file hard limit, rather than buffering an expansion bomb first.
      result = await readBoundedStream(
        stream,
        Math.min(entry.uncompressedSize, MAX_FILE_UNCOMPRESSED_BYTES),
      );
    } catch (error) {
      if (error instanceof Error && error.message === "ZIP_ENTRY_EXPANSION_LIMIT") {
        fail("A ZIP entry expanded beyond its declared or allowed size. Remove the oversized entry and try again.");
      }
      fail("A compressed ZIP entry could not be opened. Re-create the ZIP with standard Deflate compression and try again.");
    }
  }

  if (result.length !== entry.uncompressedSize) fail("A ZIP entry did not decompress to its declared size.");
  if (crc32(result) !== entry.expectedCrc) fail("The ZIP failed its integrity check. Re-create the archive and try again.");
  return result;
}

function decodeText(bytes) {
  if (!bytes || bytes.length === 0) return "";
  const sample = bytes.subarray(0, Math.min(bytes.length, 8_192));
  if (sample.includes(0)) return "";
  return decoder.decode(bytes).replace(/^\uFEFF/, "");
}

function redactPotentialSecrets(source) {
  return String(source || "")
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{30,})\b/g, "[REDACTED SECRET]")
    // Additional common provider credentials can appear as literals in source or config files.
    .replace(/\b(?:sb_secret_[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/gi, "[REDACTED SECRET]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{24,}=?/gi, "$1[REDACTED TOKEN]")
    .replace(/^(\s*(?:(?:export\s+)?(?:const|let|var)\s+)?["']?(?:[A-Za-z_][\w.-]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|CLIENT[_-]?SECRET|PRIVATE[_-]?KEY|SIGNING[_-]?KEY|KEY|TOKEN|SECRET)|PASSWORD|PASSWD)["']?\s*[:=]\s*["'`])([^"'`\r\n,;]{8,})(["'`]\s*,?\s*;?)$/gim, "$1[REDACTED]$3");
}

function entryPriority(path) {
  const name = path.toLowerCase();
  if (name === "readme.md" || name === "readme" || name === "readme.txt") return 0;
  if (name === "package.json" || name === "pyproject.toml" || name === "cargo.toml" || name === "go.mod") return 1;
  if (/^(src|app|pages|public|server|api)\//.test(name)) return 2;
  if (/(^|\/)(vite|next|tsconfig|eslint|tailwind|postcss|vitest|playwright|drizzle|prisma|supabase|vercel|wrangler)\./.test(name)) return 3;
  return 4;
}

export async function readZipTextFiles(file, options = {}) {
  if (!(file instanceof Blob)) fail("Choose a ZIP file from your device.");
  if (file.size <= 0 || file.size > MAX_ARCHIVE_BYTES) {
    fail("Project ZIP files must be 8 MB or smaller for this chat analysis. Remove dependency folders and large media before uploading.");
  }

  const buffer = await file.arrayBuffer();
  const archive = readZipDirectory(buffer);
  const allowed = options.allowedExtensions ? new Set(options.allowedExtensions) : null;
  const maxFiles = Math.min(options.maxFiles ?? MAX_SELECTED_FILES, MAX_SELECTED_FILES);
  const maxChars = Math.min(options.maxChars ?? MAX_PROJECT_CONTEXT_CHARS, MAX_PROJECT_CONTEXT_CHARS);
  const candidates = archive.entries
    .filter(entry => shouldReadPath(entry.path, allowed))
    .sort((a, b) => entryPriority(a.path) - entryPriority(b.path) || a.path.localeCompare(b.path));

  const output = [];
  const skipped = [];
  const tree = [];
  let selectedBytes = 0;
  let chars = 0;

  for (const entry of candidates) {
    if (output.length >= maxFiles || chars >= maxChars) {
      skipped.push(entry.path);
      continue;
    }
    if (entry.uncompressedSize > MAX_FILE_UNCOMPRESSED_BYTES) {
      skipped.push(entry.path + " (large file)");
      continue;
    }
    selectedBytes += entry.uncompressedSize;
    if (selectedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      skipped.push(entry.path + " (archive text limit)");
      continue;
    }
    if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 200) {
      fail("This ZIP contains a highly compressed entry that looks unsafe to expand. Re-create it without unusual compression.");
    }

    const bytes = await decompressEntry(archive, entry);
    if (!bytes) {
      skipped.push(entry.path + " (unsupported compression)");
      continue;
    }
    let content = redactPotentialSecrets(decodeText(bytes));
    if (!content.trim()) {
      skipped.push(entry.path + " (binary or empty)");
      continue;
    }
    if (content.length > 8_000) content = content.slice(0, 8_000) + "\n[File excerpt truncated for safe AI context.]";
    const remaining = maxChars - chars;
    if (content.length > remaining) content = content.slice(0, Math.max(0, remaining)) + "\n[Project context limit reached; remaining files omitted.]";
    if (!content.trim()) {
      skipped.push(entry.path);
      continue;
    }
    output.push({ path: entry.path, content });
    tree.push(entry.path);
    chars += content.length;
  }

  if (!output.length) {
    fail("No readable source or documentation files were found in this ZIP. Exclude node_modules, build output and binary assets, then try again.");
  }

  return {
    files: output,
    tree: tree.slice(0, 100),
    skipped: skipped.slice(0, 60),
    totalEntries: archive.entries.length,
    text: ""
  };
}

function xmlText(xml) {
  return String(xml || "")
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<a:br\b[^>]*\/>/g, "\n")
    .replace(/<\/(?:w:p|a:p|row|si|c)>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(0x10ffff, Number(n))))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(0x10ffff, parseInt(n, 16))))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export async function extractOfficeText(file) {
  const extension = extensionOf(file.name || "");
  const patterns = extension === ".docx"
    ? [/^word\/document\.xml$/i, /^word\/(?:header|footer)\d*\.xml$/i]
    : extension === ".xlsx"
      ? [/^xl\/sharedstrings\.xml$/i, /^xl\/worksheets\/sheet\d+\.xml$/i]
      : extension === ".pptx"
        ? [/^ppt\/slides\/slide\d+\.xml$/i, /^ppt\/notesSlides\/notesSlide\d+\.xml$/i]
        : null;

  if (!patterns) fail("Legacy .doc, .xls and .ppt files are not directly readable. Save them as .docx, .xlsx, .pptx or PDF, then attach again.");
  const archive = await readZipTextFiles(file, {
    allowedExtensions: [".xml"],
    maxFiles: 24,
    maxChars: 36_000
  });
  const matching = archive.files.filter(item => patterns.some(pattern => pattern.test(item.path)));
  if (!matching.length) fail("This Office file has no readable document text. Save a copy as PDF and attach it again.");

  const text = matching.map(item => {
    const value = xmlText(item.content);
    return value ? "[OFFICE CONTENT: " + item.path + "]\n" + value : "";
  }).filter(Boolean).join("\n\n");

  if (!text.trim()) fail("No readable text was found in this Office file.");
  return text.slice(0, 36_000);
}

export function parseProjectBundleResponse(source) {
  const open = "[[CODEFORGE_PROJECT_BUNDLE]]";
  const close = "[[/CODEFORGE_PROJECT_BUNDLE]]";
  const start = source.indexOf(open);
  const end = source.indexOf(close, start + open.length);
  if (start < 0 || end < 0) return null;

  const raw = source.slice(start + open.length, end).trim();
  if (raw.length > MAX_BUNDLE_BYTES) return null;

  try {
    const payload = JSON.parse(raw);
    if (!payload || !Array.isArray(payload.files) || payload.files.length < 1 || payload.files.length > MAX_BUNDLE_FILES) return null;
    const seen = new Set();
    let totalBytes = 0;
    const files = [];

    for (const item of payload.files) {
      if (!item || typeof item.path !== "string" || typeof item.content !== "string") return null;
      const path = safeArchivePath(item.path);
      if (!path || !shouldReadPath(path, null) && extensionOf(path) !== ".svg") return null;
      const key = path.toLowerCase();
      if (seen.has(key)) return null;
      seen.add(key);
      const filename = path.split("/").pop().toLowerCase();
      if (filename === ".env" || (filename.startsWith(".env.") && ![".env.example", ".env.sample", ".env.template"].includes(filename))) return null;
      const content = redactPotentialSecrets(item.content);
      totalBytes += encoder.encode(content).length + encoder.encode(path).length;
      if (content.length > 100_000 || totalBytes > MAX_BUNDLE_BYTES) return null;
      files.push({ path, content });
    }

    return {
      files,
      summary: typeof payload.summary === "string" ? payload.summary.slice(0, 600) : "",
      displayText: source.slice(0, start).trim()
    };
  } catch {
    return null;
  }
}

function buildZipArchive(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_ARCHIVE_ENTRIES) {
    fail("The updated archive does not contain a valid number of files.");
  }

  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  const seen = new Set();

  for (const entry of entries) {
    const path = safeArchivePath(entry.path);
    if (!path) fail("The archive contains an invalid file path.");
    const rawCompressedData = entry.compressedData;
    if (!rawCompressedData || !ArrayBuffer.isView(rawCompressedData) ||
        rawCompressedData.BYTES_PER_ELEMENT !== 1) {
      fail("The archive entry does not contain a valid byte array.");
    }
    const compressedData = new Uint8Array(
      rawCompressedData.buffer,
      rawCompressedData.byteOffset,
      rawCompressedData.byteLength
    );
    const key = path.toLowerCase();
    if (seen.has(key)) fail("The updated archive contains duplicate file paths.");
    seen.add(key);

    const name = encoder.encode(path);
    const method = Number(entry.method);
    const compressedSize = Number(entry.compressedSize);
    const uncompressedSize = Number(entry.uncompressedSize);
    const checksum = Number(entry.crc);
    if (
      !Number.isInteger(method) || method < 0 || method > 0xffff ||
      !Number.isSafeInteger(compressedSize) || compressedSize !== compressedData.length ||
      !Number.isSafeInteger(uncompressedSize) || uncompressedSize < 0 || uncompressedSize > 0xffffffff ||
      !Number.isSafeInteger(checksum) || checksum < 0 || checksum > 0xffffffff ||
      name.length > 65_535 || localOffset > 0xffffffff
    ) fail("An archive entry is outside the supported ZIP size limits.");

    // Remove only encryption and data-descriptor bits; retain other method-specific flags.
    const flags = 0x0800 | ((Number(entry.flags) || 0) & ~0x0049);
    const date = Number.isInteger(entry.modifiedDate) ? entry.modifiedDate : 0x21;
    const time = Number.isInteger(entry.modifiedTime) ? entry.modifiedTime : 0;
    const versionNeeded = Number.isInteger(entry.versionNeeded) ? entry.versionNeeded : (method === 0 ? 10 : 20);
    const localHeader = new Uint8Array(30);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, versionNeeded, true);
    localView.setUint16(6, flags, true);
    localView.setUint16(8, method, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, compressedSize, true);
    localView.setUint32(22, uncompressedSize, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);
    localParts.push(localHeader, name, compressedData);

    const centralHeader = new Uint8Array(46);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, Number.isInteger(entry.madeBy) ? entry.madeBy : 0x0314, true);
    centralView.setUint16(6, versionNeeded, true);
    centralView.setUint16(8, flags, true);
    centralView.setUint16(10, method, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, compressedSize, true);
    centralView.setUint32(24, uncompressedSize, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(
      38,
      Number.isInteger(entry.externalAttributes) ? entry.externalAttributes : ((0o100644 << 16) >>> 0),
      true
    );
    centralView.setUint32(42, localOffset, true);
    centralParts.push(centralHeader, name);

    localOffset += localHeader.length + name.length + compressedData.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  if (localOffset > 0xffffffff || centralSize > 0xffffffff) fail("The updated ZIP is too large.");
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  endView.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
}

export function createProjectZip(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_BUNDLE_FILES) {
    fail("The project bundle does not contain a valid number of files.");
  }

  let totalBytes = 0;
  const seen = new Set();
  const entries = files.map(item => {
    const path = safeArchivePath(item.path);
    if (!path || typeof item.content !== "string") fail("The project contains an invalid file path.");
    const key = path.toLowerCase();
    if (seen.has(key)) fail("The generated project contains duplicate file paths.");
    seen.add(key);

    const name = encoder.encode(path);
    const data = encoder.encode(redactPotentialSecrets(item.content));
    totalBytes += name.length + data.length;
    if (totalBytes > MAX_BUNDLE_BYTES || data.length > 0xffffffff) fail("The generated project is too large to package safely.");
    return {
      path,
      method: 0,
      flags: 0,
      crc: crc32(data),
      compressedSize: data.length,
      uncompressedSize: data.length,
      compressedData: data
    };
  });
  return buildZipArchive(entries);
}

/**
 * Patch a user-supplied ZIP without extracting or overwriting the original.
 * Unchanged safe entries keep their compressed bytes; only explicitly returned
 * files are replaced. Existing files can only be edited when their full text was
 * included in the AI context, preventing guessed edits to unseen/truncated files.
 */
function summarizeTextChanges(before, after) {
  const countLines = value => {
    const counts = new Map();
    for (const line of String(value || "").split(/\r\n|\n|\r/)) {
      if (!line) continue;
      counts.set(line, (counts.get(line) || 0) + 1);
    }
    return counts;
  };
  const beforeCounts = countLines(before);
  const afterCounts = countLines(after);
  const removed = [];
  const added = [];

  for (const [line, count] of beforeCounts) {
    const difference = count - (afterCounts.get(line) || 0);
    for (let index = 0; index < difference && removed.length < 7; index += 1) {
      removed.push("- " + line.slice(0, 220));
    }
  }
  for (const [line, count] of afterCounts) {
    const difference = count - (beforeCounts.get(line) || 0);
    for (let index = 0; index < difference && added.length < 7; index += 1) {
      added.push("+ " + line.slice(0, 220));
    }
  }

  const lines = [...removed, ...added];
  if (!lines.length) return "No line-level text differences were detected.";
  const totalRemoved = [...beforeCounts].reduce((sum, [line, count]) =>
    sum + Math.max(0, count - (afterCounts.get(line) || 0)), 0);
  const totalAdded = [...afterCounts].reduce((sum, [line, count]) =>
    sum + Math.max(0, count - (beforeCounts.get(line) || 0)), 0);
  const totalChanges = totalRemoved + totalAdded;
  return lines.join("\n") +
    (removed.length + added.length < totalChanges ? "\n…additional line changes are not shown in this preview." : "");
}

export async function createUpdatedProjectZip(file, changedFiles, editablePaths = []) {
  if (!(file instanceof Blob) || file.size <= 0 || file.size > MAX_ARCHIVE_BYTES) {
    fail("The original ZIP is missing or exceeds the 8 MB safe-editing limit.");
  }
  if (!Array.isArray(changedFiles) || changedFiles.length < 1 || changedFiles.length > MAX_BUNDLE_FILES) {
    fail("The AI did not return a valid set of file changes.");
  }

  if (!Array.isArray(editablePaths)) fail("The list of fully inspected archive files is invalid.");
  const archive = readZipDirectory(await file.arrayBuffer());
  const editable = new Set(editablePaths.map(path => safeArchivePath(path)).filter(Boolean).map(path => path.toLowerCase()));
  const originalByPath = new Map(archive.entries.map(entry => [entry.path.toLowerCase(), entry]));
  const changes = new Map();
  let changedBytes = 0;

  for (const item of changedFiles) {
    if (!item || typeof item.path !== "string" || typeof item.content !== "string") {
      fail("A proposed archive change has an invalid file format.");
    }
    const path = safeArchivePath(item.path);
    if (!path || (!shouldReadPath(path, null) && extensionOf(path) !== ".svg")) {
      fail("The proposed change contains an unsafe or unsupported file path.");
    }
    const key = path.toLowerCase();
    if (changes.has(key)) fail("The AI returned the same file path more than once.");
    const existing = originalByPath.get(key);
    if (existing && !editable.has(key)) {
      fail("The requested file was not fully included in the readable ZIP context. Upload a smaller archive containing that file before editing it.");
    }
    const finalPath = existing ? existing.path : path;
    const content = redactPotentialSecrets(item.content);
    const data = encoder.encode(content);
    changedBytes += encoder.encode(finalPath).length + data.length;
    if (content.length > 100_000 || changedBytes > MAX_BUNDLE_BYTES) {
      fail("The requested file changes exceed the safe 5 MB editing limit.");
    }
    changes.set(key, {
      path: finalPath,
      method: 0,
      flags: 0,
      crc: crc32(data),
      compressedSize: data.length,
      uncompressedSize: data.length,
      compressedData: data,
      madeBy: existing?.madeBy ?? 0x0314,
      versionNeeded: 10,
      externalAttributes: existing?.externalAttributes ?? ((0o100644 << 16) >>> 0),
      modifiedTime: existing?.modifiedTime,
      modifiedDate: existing?.modifiedDate,
      updated: Boolean(existing)
    });
  }

  const output = [];
  let updatedFiles = 0;
  let preservedEntries = 0;
  let addedFiles = 0;
  let additionalOmittedEntries = 0;
  let sanitizedTextBytes = 0;
  const changePreviews = [];

  for (const entry of archive.entries) {
    const key = entry.path.toLowerCase();
    const replacement = changes.get(key);
    if (replacement) {
      const originalBytes = await decompressEntry(archive, entry);
      if (!originalBytes) {
        fail("The original file could not be fully verified before editing. No updated ZIP was created.");
      }
      const originalHadBom = originalBytes.length >= 3 &&
        originalBytes[0] === 0xef && originalBytes[1] === 0xbb && originalBytes[2] === 0xbf;
      let originalText;
      try {
        originalText = redactPotentialSecrets(new TextDecoder("utf-8", { fatal: true }).decode(originalBytes).replace(/^\uFEFF/, ""));
      } catch {
        fail("The original file is not valid UTF-8 text. No updated ZIP was created.");
      }
      const originalLineEnding = originalText.match(/\r\n|\r|\n/)?.[0] || "\n";
      const originalTrailingNewlines = originalText.match(/(?:\r\n|\r|\n)+$/)?.[0] || "";
      const requestedText = decoder.decode(replacement.compressedData)
        .replace(/\r\n|\r|\n/g, originalLineEnding)
        .replace(/(?:\r\n|\r|\n)+$/, "") + originalTrailingNewlines;
      const finalText = (originalHadBom ? "\uFEFF" : "") + requestedText;
      const finalBytes = encoder.encode(finalText);
      changedBytes += finalBytes.length - replacement.compressedData.length;
      if (changedBytes > MAX_BUNDLE_BYTES) {
        fail("Preserving the original file encoding would exceed the safe 5 MB editing limit.");
      }
      replacement.compressedData = finalBytes;
      replacement.compressedSize = finalBytes.length;
      replacement.uncompressedSize = finalBytes.length;
      replacement.crc = crc32(finalBytes);
      if (changePreviews.length < 12) {
        changePreviews.push({
          path: entry.path,
          kind: "updated",
          preview: summarizeTextChanges(originalText, requestedText)
        });
      }
      output.push(replacement);
      updatedFiles += 1;
      changes.delete(key);
      continue;
    }

    if (entry.flags & 0x0041) fail("Encrypted ZIP entries cannot be safely preserved.");
    const offset = entry.localOffset;
    if (offset + 30 > archive.bytes.length || archive.view.getUint32(offset, true) !== 0x04034b50) {
      fail("An original ZIP entry has an invalid local file header.");
    }
    const localFlags = archive.view.getUint16(offset + 6, true);
    const localMethod = archive.view.getUint16(offset + 8, true);
    const filenameLength = archive.view.getUint16(offset + 26, true);
    const extraLength = archive.view.getUint16(offset + 28, true);
    const dataOffset = offset + 30 + filenameLength + extraLength;
    const dataEnd = dataOffset + entry.compressedSize;
    if (
      (localFlags & 0x0041) ||
      localFlags !== entry.flags ||
      localMethod !== entry.method ||
      dataOffset < offset + 30 ||
      dataEnd > archive.directoryOffset ||
      dataEnd > archive.bytes.length
    ) fail("An original ZIP entry has inconsistent compressed data and cannot be safely preserved.");
    const localNameBytes = archive.bytes.subarray(offset + 30, offset + 30 + filenameLength);
    const localName = (localFlags & 0x0800)
      ? new TextDecoder("utf-8", { fatal: true }).decode(localNameBytes)
      : new TextDecoder("windows-1252").decode(localNameBytes);
    if (localName.replace(/\\/g, "/") !== entry.path) {
      fail("An original ZIP entry's local filename does not match its directory entry.");
    }

    // Carry every unchanged safe entry forward as its original compressed bytes.
    // Do not drop large, unsupported-compression, binary, or non-UTF-8 files simply
    // because the AI could not inspect them. Only explicitly changed files are rewritten.
    output.push({
      path: entry.path,
      method: entry.method,
      flags: entry.flags,
      crc: entry.expectedCrc,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      compressedData: archive.bytes.slice(dataOffset, dataEnd),
      madeBy: entry.madeBy,
      versionNeeded: entry.versionNeeded,
      externalAttributes: entry.externalAttributes,
      modifiedTime: entry.modifiedTime,
      modifiedDate: entry.modifiedDate
    });
    preservedEntries += 1;
  }

  for (const addition of changes.values()) {
    if (changePreviews.length < 12) {
      changePreviews.push({
        path: addition.path,
        kind: "added",
        preview: summarizeTextChanges("", decoder.decode(addition.compressedData))
      });
    }
    output.push(addition);
    addedFiles += 1;
  }
  if (!output.length || output.length > MAX_ARCHIVE_ENTRIES) {
    fail("The updated ZIP would exceed the supported archive entry limit.");
  }

  const blob = buildZipArchive(output);
  if (blob.size > MAX_ARCHIVE_BYTES + MAX_BUNDLE_BYTES) {
    fail("The updated ZIP exceeds the 13 MB safe output limit.");
  }
  return {
    blob,
    updatedFiles,
    addedFiles,
    preservedEntries,
    changePreviews,
    omittedEntries: Math.max(0, archive.totalEntries - archive.entries.length) + additionalOmittedEntries
  };
}

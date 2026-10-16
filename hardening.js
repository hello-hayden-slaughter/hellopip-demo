// Main-process hardening decisions, pure (no `electron` import) so
// tests/smoke/test_electron_hardening.js can run them under plain node.
// electron.js hangs them on the places that matter; the audit findings they
// answer are named at each one (docs/audits/2026-10-release, F-018 to F-020).

const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");

// ── F-018: what "Open" may hand to another app ─────────────────────────────
//
// `open-path-external` gives a path to LaunchServices, which runs whatever the
// Mac has set for that kind: a .command opens Terminal and runs, a .py can go
// to Python Launcher, a .app launches. A file in the workspace can be anything
// (Claude's save_file takes any extension; a sync service drops what it likes),
// so the Open button is an allow-list of document kinds, not a list of bad ones.
// Anything else is shown in Finder, where opening it is the person's own move.
//
// What is on the list is what Pip itself offers to open in another app (every
// Office kind it reads: fileKinds.ts and workspace_files.py, held in step by
// tests/smoke/test_electron_hardening.js) plus the pictures, sound, video,
// design and plain-text kinds a small business keeps beside them. Left out on
// purpose: html/htm/svg (a page that runs in the browser), every code and
// script type, archives, disk images, installers, plists and bundles.
const OPENABLE_EXTENSIONS = Object.freeze([
  // documents (Pip's DOCUMENT_EXT: docx docm dotx doc rtf odt pages epub)
  "pdf", "doc", "docx", "docm", "dot", "dotx", "odt", "ott", "rtf", "pages", "epub", "txt", "text", "md", "markdown",
  // spreadsheets (SHEET_EXT)
  "xls", "xlsx", "xlsm", "xltx", "ods", "numbers", "csv", "tsv",
  // presentations (SLIDES_EXT)
  "ppt", "pptx", "ppsx", "potx", "pps", "odp", "key",
  // pictures (_IMAGE_EXT without svg), camera raw and design files
  "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "avif", "ico",
  "cr2", "cr3", "nef", "arw", "dng", "raf", "orf", "rw2",
  "psd", "psb", "ai", "eps", "indd", "sketch", "xd", "fig",
  // sound and video
  "mp3", "m4a", "wav", "aif", "aiff", "aac", "flac", "ogg", "opus", "caf", "wma",
  "mp4", "m4v", "mov", "webm", "mkv", "avi", "wmv", "mpg", "mpeg", "3gp",
  // plain text and data (not source code)
  "json", "jsonl", "ndjson", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "log",
  "rst", "tex", "org", "srt", "vtt",
]);
const OPENABLE = new Set(OPENABLE_EXTENSIONS);

// A folder that is one document: an iWork file saved as a package. Any other
// folder with an extension is a bundle (.app, .workflow, .pkg …).
const OPENABLE_PACKAGES = new Set(["pages", "numbers", "key"]);

function extensionOf(p) {
  return path.extname(String(p || "")).slice(1).toLowerCase();
}

// The first 16 bytes of a Finder alias file (bookmark data); the backend's
// `is_finder_alias` agrees, which standalone/tests/test_workspace_link_alias.py holds.
const ALIAS_MAGIC = Buffer.from("book\0\0\0\0mark\0\0\0\0", "latin1");

/**
 * Whether `file` is a Finder alias: a small file of bookmark data that opens
 * whatever it points at (a linked file, ADR-0071). It keeps its target's name,
 * so its name says nothing about what Open would launch.
 */
function isFinderAlias(file, fsImpl = fs) {
  let fd;
  try {
    fd = fsImpl.openSync(file, "r");
    const head = Buffer.alloc(ALIAS_MAGIC.length);
    const n = fsImpl.readSync(fd, head, 0, head.length, 0);
    return n === head.length && head.equals(ALIAS_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * "open" or "reveal" for a path the person asked to open in another app.
 * `realPath` is where a symlink really leads: both names must pass. `isLink` is
 * a Finder alias, which realPath can not follow: it is always revealed, because
 * neither its name nor its path says what would run. A folder opens in Finder; a folder with an extension
 * (`Thing.app`, `x.workflow`, any bundle) is revealed, except an iWork package.
 */
function openVerdict(target, { realPath, isDirectory = false, isLink = false } = {}) {
  if (isLink) return "reveal";
  const names = [target];
  if (realPath && realPath !== target) names.push(realPath);
  for (const name of names) {
    const ext = extensionOf(name);
    if (isDirectory) {
      if (ext !== "" && !OPENABLE_PACKAGES.has(ext)) return "reveal";
    } else if (!OPENABLE.has(ext)) {
      return "reveal";
    }
  }
  return "open";
}

const REVEALED_INSTEAD =
  "Pip doesn't open this kind of file itself, so it's shown in Finder. Open it from there if you trust it.";

// ── F-020: renderer error text on its way to main.log ──────────────────────
//
// main.log ships in the diagnostics zip the person emails. The renderer is the
// window that shows other people's words, so what it reports is capped and can
// not forge a log line.
const ERROR_FIELD_MAX = 8 * 1024;
const ERROR_BYTES_PER_MINUTE = 256 * 1024;

function capText(value, max = ERROR_FIELD_MAX) {
  const s = typeof value === "string" ? value : value == null ? "" : String(value);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}... [${s.length - max} more characters cut]`;
}

// Every line after the first is indented, so renderer text can never begin a
// line of its own that looks like one main wrote.
function indentContinuations(s) {
  return s.replace(/\r\n?|\n/g, "\n    ");
}

/** The one log line for a renderer error payload; every field capped. */
function rendererErrorLine(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const kind = capText(p.kind || "error", 64).replace(/\s+/g, " ");
  const msg = capText(p.message || "(no message)");
  const where = p.source ? ` @ ${capText(p.source, 512).replace(/\s+/g, " ")}` : "";
  const stack = p.stack ? `\n${capText(p.stack)}` : "";
  return indentContinuations(`[RENDERER ${kind}] ${msg}${where}${stack}`);
}

/**
 * A byte budget per rolling minute. `admit(n)` answers "ok", "first-over" (log
 * one line saying errors are being dropped) or "over" (drop it silently).
 */
function createErrorBudget({ maxBytes = ERROR_BYTES_PER_MINUTE, windowMs = 60 * 1000, now = Date.now } = {}) {
  let windowStart = now();
  let used = 0;
  let announced = false;
  return {
    admit(bytes) {
      const t = now();
      if (t - windowStart >= windowMs) {
        windowStart = t;
        used = 0;
        announced = false;
      }
      if (used + bytes <= maxBytes) {
        used += bytes;
        return "ok";
      }
      if (!announced) {
        announced = true;
        return "first-over";
      }
      return "over";
    },
  };
}

// ── F-019: the hidden windows that print HTML to a PDF ─────────────────────
//
// They load a document Pip did not write (a workspace .html file, a note's
// HTML with its authors' words in it). Three locks that overlap: the page
// carries a CSP (first in a head of our own, so the document can not move it);
// the window's own session cancels every request but the one temp page and
// data: URLs, which is the lock that stops a local file; and navigation is
// refused. The backend already inlines what a document needs as data: URIs
// (ADR-0046), and a note's print page carries its font that way.
const PDF_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:; base-uri 'none'; form-action 'none'";
const PDF_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PDF_CSP}">`;
// Our own doctype, html and head, closed before the document starts, with the
// policy as the head's only content. The document is not searched or parsed:
// whatever it holds (a <head> inside a comment or an attribute, content before
// its own <head>, a frameset) comes after a policy that is already in force, and
// its own <html>/<head>/<body> tags merge into ours or are ignored.
const PDF_PREAMBLE = `<!doctype html><html><head><meta charset="utf-8">${PDF_CSP_META}</head><body>`;

/** `html` behind a head that holds the CSP and nothing else. */
function sealPdfHtml(html) {
  return PDF_PREAMBLE + String(html);
}

/**
 * Whether a PDF window may make this request: a `data:` URL, or the temp page
 * itself (`allowedPaths` is the set of absolute paths of the pages being
 * rendered right now). Everything else, every `file:` and every network URL,
 * is cancelled.
 */
function pdfRequestAllowed(url, allowedPaths) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return false;
  }
  if (u.protocol === "data:") return true;
  if (u.protocol !== "file:") return false;
  try {
    return allowedPaths.has(fileURLToPath(u));
  } catch {
    return false;
  }
}

/**
 * The `webRequest.onBeforeRequest` listener for the PDF session. `pages` is the
 * live set of in-flight page paths; `warn` logs a refusal. Pure so a test can
 * hand it requests the way Chromium names them and read the answer.
 */
function createPdfRequestFilter(pages, warn = () => {}) {
  return (details, callback) => {
    const url = details && details.url;
    const ok = pdfRequestAllowed(url, pages);
    if (!ok) warn(`[pip] pdf render request refused: ${String(url).slice(0, 120)}`);
    callback({ cancel: !ok });
  };
}

// ── F-020: the arguments of open-popout ────────────────────────────────────

const POPOUT_VIEWS = new Set(["chat", "note", "canvas", "table"]);

/** Whether `open-popout`'s arguments are a view Pip has and an id that can ride in a URL. */
function popoutArgsValid(view, id) {
  return typeof view === "string" && POPOUT_VIEWS.has(view)
    && typeof id === "string" && id.length > 0 && id.length <= 512;
}

// ── F-020: the auth token on disk ──────────────────────────────────────────

/**
 * Write `content` to `file` as a new file made 0600 from its first byte. An
 * older file (made by an earlier build, possibly 0644) is removed first, so the
 * new token is never in a file others can read, even for an instant; a symlink
 * planted there is replaced, not followed (`wx` refuses an existing path).
 */
function writePrivateFile(file, content) {
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, content, { mode: 0o600, flag: "wx" });
  fs.chmodSync(file, 0o600);
}

/** Remove `file` only if it still holds `content`: a newer launch's token is not ours to delete. */
function removeFileIfHolds(file, content) {
  try {
    if (fs.readFileSync(file, "utf8") !== content) return false;
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  OPENABLE_EXTENSIONS,
  REVEALED_INSTEAD,
  openVerdict,
  isFinderAlias,
  ERROR_FIELD_MAX,
  ERROR_BYTES_PER_MINUTE,
  capText,
  rendererErrorLine,
  createErrorBudget,
  PDF_CSP,
  sealPdfHtml,
  pdfRequestAllowed,
  popoutArgsValid,
  createPdfRequestFilter,
  writePrivateFile,
  removeFileIfHolds,
};

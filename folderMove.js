// Moving the notes folder or Pip's data folder somewhere else without overwriting anything
// (release audit A4, F-025).
//
// Pure node, no `electron` import, so `tests/smoke/test_main_guards.js` can exercise it without
// launching an app. `electron.js` requires this module; it must also be listed in
// `desktop/package.json`'s `build.files` or the packaged main process can't find it.
//
// The move used to be `fs.cpSync(each, …, { recursive: true })` into the chosen folder, which
// overwrites a file of the same name (Node's `force` defaults to true), then a delete of every
// original. Choosing a folder that already held someone's `README.md` (Pip's own root
// `README.md` alone is enough) replaced it with Pip's and deleted Pip's original; a crash
// part-way left Pip pointed at a half-emptied folder or, next time, adopting a half copy.
//
// Now, in this order, and each step leaves the one before it intact:
//
//   1. PLAN. Every path under the source is looked up in the destination. A path that is in
//      both and is not a folder in both is a COLLISION, and the move is refused, before anything
//      is touched, with one plain sentence naming up to five of them (`collisionSentence`). A
//      folder in both is merged into: it is not a collision, its contents are looked at. What the
//      destination has no path for becomes a ROOT: one file, link or whole folder to copy.
//   2. MARK. `pending-move.json` (kept beside the app's settings, outside both folders) is
//      written with the source, destination and every root, phase "copying".
//   3. COPY each root with `force: false, errorOnExist: true`, so a file that appeared meanwhile
//      stops the copy rather than being replaced.
//   4. VERIFY. Every root's tree, in the source and at the destination, has the same paths, the
//      same kinds and the same sizes (counts and bytes). Phase "verified".
//   5. POINTER. The settings are pointed at the destination. Phase "pointer".
//   6. DELETE the source's roots, and the folders that empties; the marker goes.
//
// A crash is read from the marker at the next start (`recover`): "copying" rolls back (the
// destination's roots are removed: every one is something this move created, because the plan
// found nothing there), "verified" carries on (the copy is whole and checked), "pointer" finishes
// the delete. The source is never removed before the pointer is written, and a destination that
// is not marked complete is never adopted as a folder to use.

const fs = require("fs");
const path = require("path");

/** Finder droppings: never copied, never a collision, never counted. */
const IGNORED_NAMES = new Set([".DS_Store"]);
/** How many collisions are looked for before the scan stops: the sentence names five. */
const COLLISION_SCAN_LIMIT = 200;
/** How many are named in the sentence. */
const COLLISIONS_NAMED = 5;
const PENDING_FILE_NAME = "pending-move.json";

class MoveRefused extends Error {
  /** `sentence` is for the person; it is also the error's message. */
  constructor(sentence, details = {}) {
    super(sentence);
    this.name = "MoveRefused";
    this.sentence = sentence;
    Object.assign(this, details);
  }
}

function kindOf(stat) {
  if (stat.isSymbolicLink()) return "link";
  if (stat.isDirectory()) return "dir";
  if (stat.isFile()) return "file";
  return "other";
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => !IGNORED_NAMES.has(n)).sort();
  } catch (e) {
    return [];
  }
}

/**
 * Look at the destination for every path under the source: what to copy (`roots`, relative
 * paths using "/") and what would be overwritten (`collisions`). A folder in both is
 * descended into; anything else in both is a collision. `total` counts every collision found,
 * up to COLLISION_SCAN_LIMIT; `paths` is all of those found (the sentence names five).
 */
function planMove(srcDir, destDir) {
  const roots = [];
  const collisions = [];
  let total = 0;
  const visit = (rel) => {
    const s = path.join(srcDir, rel);
    const d = path.join(destDir, rel);
    const sStat = fs.lstatSync(s);
    const dStat = lstatOrNull(d);
    if (!dStat) {
      roots.push(rel);
      return;
    }
    if (sStat.isDirectory() && dStat.isDirectory()) {
      for (const name of listDir(s)) {
        if (total >= COLLISION_SCAN_LIMIT) return;
        visit(rel ? `${rel}/${name}` : name);
      }
      return;
    }
    total += 1;
    collisions.push(rel);
  };
  for (const name of listDir(srcDir)) {
    if (total >= COLLISION_SCAN_LIMIT) break;
    visit(name);
  }
  return { roots, collisions, total };
}

/** The one plain sentence a refused move says: how many, which (up to five), and that nothing was changed. */
function collisionSentence({ collisions, total }) {
  const named = collisions.slice(0, COLLISIONS_NAMED).join(", ");
  const more = total > COLLISIONS_NAMED ? `, and ${total - COLLISIONS_NAMED} more` : "";
  const what =
    total === 1
      ? "a file named the same as one Pip would put there"
      : `${total >= COLLISION_SCAN_LIMIT ? "at least " : ""}${total} files named the same as ones Pip would put there`;
  return (
    `That folder already has ${what}: ${named}${more}. ` +
    `Pip won't replace anything, so nothing was moved. Pick an empty folder, or move those out of the way first.`
  );
}

/**
 * What makes a folder one that Pip will adopt, copied LAST: a half copy that has any of them looks like a finished one
 * (`hasPipWorkspace`, `hasPipData`). The notes folder's is `.pip/index.json`; a data folder's are these. The marker
 * (`pending-move.json`) is what refuses to adopt a move that did not finish; this order is the second lock.
 */
const COPIED_LAST = [".pip", "vault.json", "config.yaml", "MEMORY.md", "working_memory", "data"];
const LAST_OF_ALL = ".pip/index.json";

/** The order roots are copied in: everything else first, what makes the folder Pip's last. */
function copyOrder(roots) {
  const rank = (rel) => {
    if (rel === LAST_OF_ALL) return COPIED_LAST.length + 1;
    const at = COPIED_LAST.indexOf(rel.split("/")[0]);
    return at < 0 ? 0 : at + 1;
  };
  return roots
    .map((rel, i) => ({ rel, i, rank: rank(rel) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.rel);
}

/** A short fingerprint of one root as it stands in `base`: the paths, kinds, sizes and times of everything under it. */
function fingerprint(base, rel) {
  const crypto = require("crypto");
  const lines = [];
  const visit = (r) => {
    const stat = lstatOrNull(path.join(base, r));
    if (!stat) return;
    const kind = kindOf(stat);
    lines.push(`${r}|${kind}|${kind === "file" ? stat.size : ""}|${kind === "file" ? Math.floor(stat.mtimeMs) : ""}`);
    if (kind === "dir") for (const name of listDir(path.join(base, r))) visit(`${r}/${name}`);
  };
  visit(rel);
  return crypto.createHash("sha1").update(lines.join("\n")).digest("hex");
}

/** `{ files, links, dirs, bytes, paths: Map(rel → "kind:size") }` for one root, in `base`. */
function inventory(base, rel) {
  const out = { files: 0, links: 0, dirs: 0, bytes: 0, paths: new Map() };
  const visit = (r) => {
    const stat = lstatOrNull(path.join(base, r));
    if (!stat) return;
    const kind = kindOf(stat);
    if (kind === "dir") {
      out.dirs += 1;
      out.paths.set(r, "dir");
      for (const name of listDir(path.join(base, r))) visit(`${r}/${name}`);
    } else if (kind === "file") {
      out.files += 1;
      out.bytes += stat.size;
      out.paths.set(r, `file:${stat.size}`);
    } else {
      out.links += kind === "link" ? 1 : 0;
      out.paths.set(r, kind);
    }
  };
  visit(rel);
  return out;
}

/** Compare the source's and the destination's copy of each root: the same paths, kinds and sizes. */
function verifyCopy(srcDir, destDir, roots) {
  const problems = [];
  let files = 0;
  let bytes = 0;
  for (const rel of roots) {
    const a = inventory(srcDir, rel);
    const b = inventory(destDir, rel);
    files += a.files;
    bytes += a.bytes;
    for (const [p, v] of a.paths) {
      if (!b.paths.has(p)) problems.push(`${p} is missing from the copy`);
      else if (b.paths.get(p) !== v) problems.push(`${p} is ${b.paths.get(p)} in the copy but ${v} in the original`);
    }
    for (const p of b.paths.keys()) {
      if (!a.paths.has(p)) problems.push(`${p} is in the copy and not in the original`);
    }
    if (problems.length > 20) break;
  }
  return { ok: problems.length === 0, files, bytes, problems };
}

/** Copy one root, never over anything. */
function defaultCopyRoot(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: false, errorOnExist: true });
}

function removePath(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

/** Remove the (now empty) folders above a deleted root, up to but not including `stopAt`. */
function pruneEmptyParents(stopAt, rel) {
  let dir = path.dirname(path.join(stopAt, rel));
  while (dir.length > stopAt.length && dir.startsWith(stopAt + path.sep)) {
    if (listDir(dir).length > 0) break;
    try {
      fs.rmSync(path.join(dir, ".DS_Store"), { force: true });
      fs.rmdirSync(dir);
    } catch (e) {
      break;
    }
    dir = path.dirname(dir);
  }
}

function readPending(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    return null;
  }
}

/**
 * A mover for one marker file. `writeJson(file, value)` must be atomic (`mainGuards.writeJsonAtomic`).
 *
 * `begin({ kind, setting, from, to })` plans the move and throws `MoveRefused` (with a
 * sentence) when anything would be overwritten or an earlier move never finished; it writes the
 * marker. The returned move has `copy()`, `pointer(write)`, `finish()` and `abort()`.
 */
function createMover({ pendingFile: pendingFileOrGetter, writeJson, log = () => {}, copyRoot = defaultCopyRoot }) {
  // A function is asked each time: the app's settings folder is not known until the app is up.
  const pending = () => (typeof pendingFileOrGetter === "function" ? pendingFileOrGetter() : pendingFileOrGetter);

  function save(state) {
    writeJson(pending(), state);
  }

  /** Look, touch nothing: throws `MoveRefused` with the sentence when the move cannot be made, else returns the plan. */
  function check(from, to) {
    if (fs.existsSync(pending())) throw new MoveRefused(pendingSentence(readPending(pending())), { code: "pending" });
    if ((from + path.sep).startsWith(to + path.sep)) {
      throw new MoveRefused("Pick a folder that isn't the one holding this folder, or any folder above it.", { code: "parent" });
    }
    const plan = planMove(from, to);
    if (plan.collisions.length > 0) {
      throw new MoveRefused(collisionSentence(plan), { code: "collisions", collisions: plan.collisions, total: plan.total });
    }
    return plan;
  }

  /**
   * About to point Pip at a folder WITHOUT moving anything into it (one that already holds Pip's files, or a new one).
   * A marker left by a move that finished its pointer and never its delete is dropped: the person has chosen where Pip
   * lives, and a marker that still said "delete the old folder once Pip lives in the new one" must not outlive that
   * choice (the review of A4: it would have deleted the folder they chose). Both folders are left as they are. A marker
   * of a move that did not get as far as the pointer says there is a half copy at its destination: that folder is
   * refused (a half copy is not a folder to use), and any other choice leaves the marker for the next start to tidy.
   */
  function beforeAdopt(to) {
    if (!fs.existsSync(pending())) return;
    const state = readPending(pending());
    if (state && state.phase === "pointer") {
      log("[move] an earlier move's marker was dropped: the person chose a folder to use instead");
      removePath(pending());
      return;
    }
    if (state && state.to === to) throw new MoveRefused(pendingSentence(state), { code: "pending" });
  }

  function begin({ kind, setting, from, to }) {
    const plan = check(from, to);
    const state = {
      version: 1,
      kind,
      setting,
      from,
      to,
      roots: copyOrder(plan.roots),
      phase: "copying",
      startedAt: new Date().toISOString(),
    };
    save(state);
    return {
      state,
      /** Copy every root, then check the copy. Throws (after taking back what it copied) if either fails. */
      copy() {
        try {
          for (const rel of state.roots) {
            // Something that arrived since the plan is not ours to replace, or to take back.
            if (lstatOrNull(path.join(to, rel))) throw new Error(`${rel} appeared in the new folder while Pip was copying`);
            copyRoot(path.join(from, rel), path.join(to, rel));
          }
          const verdict = verifyCopy(from, to, state.roots);
          if (!verdict.ok) {
            throw new Error(`the copy doesn't match the original (${verdict.problems.slice(0, 3).join("; ")})`);
          }
          state.phase = "verified";
          state.files = verdict.files;
          state.bytes = verdict.bytes;
          // What each root of the original is, now that it is copied: the delete takes a root only if it is still this
          // (a sync client may write into the old folder while Pip starts in the new one).
          state.prints = {};
          for (const rel of state.roots) state.prints[rel] = fingerprint(from, rel);
          save(state);
          return verdict;
        } catch (err) {
          this.abort();
          throw err;
        }
      },
      /** Point the settings at the destination. `write()` does it. */
      pointer(write) {
        write();
        state.phase = "pointer";
        save(state);
      },
      /** Delete the source's roots (each only while the destination still has its copy) and clear the marker. */
      finish() {
        finishDelete(state, log);
        removePath(pending());
      },
      /** Take back what the copy made (the roots, which did not exist at the destination before) and clear the marker. */
      abort() {
        rollBack(state, log);
        // A new folder that cannot be reached (a drive unplugged mid-copy) cannot be tidied, and what is in it is a half
        // copy that looks like a folder to adopt: the marker stays until it can be.
        if (fs.existsSync(state.to)) removePath(pending());
        else log("[move] the new folder cannot be reached; the move's marker stays until it can be tidied");
      },
    };
  }

  /**
   * Put right a move a crash interrupted, from the marker alone. Returns what it did, or null when there
   * was nothing. `settings` is `{ read(), write(patch) }` for the app's settings file.
   */
  function recover(settings) {
    const state = readPending(pending());
    if (!state) {
      if (fs.existsSync(pending())) {
        // Unreadable: nothing in it says what is half done, and guessing would delete things. Leave the destination
        // alone, keep the source (the settings still point at it unless they were written), and stop asking.
        log("[move] the move marker is unreadable; leaving both folders as they are");
        removePath(pending());
        return { action: "left alone", reason: "unreadable marker" };
      }
      return null;
    }
    // A new folder that cannot be reached (an external drive that is not plugged in) cannot be tidied: nothing there can
    // be taken back, and nothing may be pointed at or deleted for. The marker stays, so a half copy in it is never
    // adopted and the next start tries again.
    if (!fs.existsSync(state.to)) {
      log(`[move] the new folder ${state.to} cannot be reached; the move's marker stays until it can be tidied`);
      return { action: "waiting", from: state.from, to: state.to };
    }
    const pointedAtTo = settings.read()[state.setting] === state.to;
    let result;
    if (state.phase === "copying") {
      if (pointedAtTo) {
        log("[move] the move was copying but the pointer is already at the new folder; leaving both as they are");
        result = { action: "left alone", from: state.from, to: state.to };
      } else {
        rollBack(state, log);
        result = { action: "rolled back", from: state.from, to: state.to };
      }
    } else if (state.phase === "verified") {
      // The copy is whole and checked, only the pointer is missing: carry on.
      if (!pointedAtTo) settings.write({ [state.setting]: state.to });
      finishDelete(state, log);
      result = { action: "completed", from: state.from, to: state.to };
    } else if (state.phase === "pointer") {
      if (pointedAtTo) {
        finishDelete(state, log);
        result = { action: "finished the delete", from: state.from, to: state.to };
      } else {
        // Pip no longer lives in the new folder (the person chose another, or the old one again, after the pointer was
        // written and before the delete). The old folder may be the one in use now: nothing is deleted.
        log("[move] the pointer is no longer at the new folder; leaving both folders as they are");
        result = { action: "left alone", from: state.from, to: state.to };
      }
    } else {
      result = { action: "left alone", from: state.from, to: state.to };
    }
    removePath(pending());
    return result;
  }

  return { begin, beforeAdopt, check, recover };
}

/** Is this file at `dest` the copy of the one at `src`, whole or cut short? Its bytes are the start of the source's.
 *  A file someone else put there (or one that has since been changed) is not. */
function isStartOf(src, dest) {
  let a = null;
  let b = null;
  try {
    a = fs.openSync(src, "r");
    b = fs.openSync(dest, "r");
    const size = fs.fstatSync(b).size;
    if (size > fs.fstatSync(a).size) return false;
    const x = Buffer.alloc(65536);
    const y = Buffer.alloc(65536);
    let at = 0;
    while (at < size) {
      const n = Math.min(x.length, size - at);
      if (fs.readSync(a, x, 0, n, at) !== n || fs.readSync(b, y, 0, n, at) !== n) return false;
      if (!x.subarray(0, n).equals(y.subarray(0, n))) return false;
      at += n;
    }
    return true;
  } catch (e) {
    return false;
  } finally {
    if (a !== null) fs.closeSync(a);
    if (b !== null) fs.closeSync(b);
  }
}

/** Is everything at `dest/rel` the copy this move made (whole or cut short), so that taking it back takes nothing
 *  of anyone else's? Same paths and kinds as the source has, and every file the start of the source's. */
function isOurCopy(srcDir, destDir, rel) {
  const a = inventory(srcDir, rel).paths;
  for (const [p, v] of inventory(destDir, rel).paths) {
    const kind = v.split(":")[0];
    if (kind !== (a.get(p) || "").split(":")[0]) return false;
    if (kind === "file" && !isStartOf(path.join(srcDir, p), path.join(destDir, p))) return false;
  }
  return true;
}

function rollBack(state, log) {
  for (const rel of state.roots || []) {
    const there = lstatOrNull(path.join(state.to, rel));
    if (!there) continue;
    // A root is taken back only if it is the copy this move made: the plan found nothing at the path, but a file that
    // arrived since is the person's.
    if (!isOurCopy(state.from, state.to, rel)) {
      log(`[move] left ${rel} in the new folder: it is not a copy of the original`);
      continue;
    }
    try {
      removePath(path.join(state.to, rel));
    } catch (e) {
      log(`[move] could not take back ${rel}: ${e.message}`);
    }
  }
  // No folder is made for a root: its parent is a folder the new place already had, which stays.
}

function finishDelete(state, log) {
  const deleted = [];
  for (const rel of state.roots || []) {
    const there = lstatOrNull(path.join(state.to, rel));
    if (!there) {
      log(`[move] kept ${rel} at the old place: the new place has no copy of it`);
      continue;
    }
    // A root that is not what was copied (something wrote into it since: a sync client, the old folder opened in
    // another app) was never copied as it is now, so it is left where it is.
    const printed = state.prints && state.prints[rel];
    if (printed && fingerprint(state.from, rel) !== printed) {
      log(`[move] kept ${rel} at the old place: it changed after it was copied`);
      continue;
    }
    try {
      removePath(path.join(state.from, rel));
      deleted.push(rel);
    } catch (e) {
      log(`[move] could not remove ${rel} from the old place: ${e.message}`);
    }
  }
  for (const rel of deleted) pruneEmptyParents(state.from, rel);
}

/** The sentence for a marker that is still there: the earlier move, and what to do about it. */
function pendingSentence(state) {
  if (state && state.to && !fs.existsSync(state.to)) {
    return `An earlier move into ${state.to} didn't finish, and Pip can't reach that folder to tidy it up. Reconnect it and open Pip again.`;
  }
  return "An earlier move didn't finish, and Pip hasn't been able to tidy it up yet. Quit and open Pip again, then try once more.";
}

module.exports = {
  COLLISIONS_NAMED,
  COLLISION_SCAN_LIMIT,
  IGNORED_NAMES,
  MoveRefused,
  PENDING_FILE_NAME,
  collisionSentence,
  copyOrder,
  createMover,
  fingerprint,
  inventory,
  planMove,
  verifyCopy,
};

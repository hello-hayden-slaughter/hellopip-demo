// Quitting Pip without losing what was just typed, and without leaving the backend
// behind (release audit A4: F-031, F-032).
//
// Pure node, no `electron` import, so `tests/smoke/test_main_guards.js` can exercise it
// without launching an app — the same move `mainGuards.js` makes. `electron.js` requires
// this module; it must also be listed in `desktop/package.json`'s `build.files` or the
// packaged main process can't find it.
//
// A quit used to be: SIGTERM to the backend at once, windows closed. A save still in an
// editor's debounce (a note, a canvas, a deck) died with the window, and a backend busy
// with something outlived the app by tens of seconds. Now it is, in this order:
//
//   1. every window's page is asked to land every save it holds and to answer once the
//      backend has acknowledged each one (`createFlushCoordinator`), for at most
//      FLUSH_WAIT_MS — a page that never answers (hung, or the backend is down) must not
//      keep a person from quitting;
//   1b. if a page reports something it could not save, the person is asked, with the system's
//      own dialog, whether to quit anyway (`createQuitConfirm`); "Keep Pip open" calls the
//      whole quit off;
//   2. the windows are put away, so nothing is typed after the answer and the page does not
//      flash "reconnecting" while the backend stops;
//   3. the backend is asked to stop and the quit waits for it to be gone, for at most
//      STOP_WAIT_MS, after which it is killed (`stopChild`).
//
// `createQuitSequence` runs the three and is the one place their order is written down.

/** How long the pages get to land their saves. */
const FLUSH_WAIT_MS = 3000;
/** How long the backend gets to exit after it is asked to, before SIGKILL. The backend
 *  means to be gone in about two seconds and leaves by itself after four
 *  (`standalone/src/shutdown.py`); this is longer than that. */
const STOP_WAIT_MS = 5000;

/**
 * Ask pages to flush their saves and wait for every answer, up to `timeoutMs`.
 *
 * A page is asked only if it said it can answer (`ready`): a window still loading holds
 * nothing unsaved, and waiting out the cap for it would only slow the quit. The answer is
 * `{ ok, unsaved? }` — `ok: false` with the names of what could not be saved (a save the
 * backend refused: paused saves). Asking never throws: a target that cannot be sent to is
 * counted as one that did not answer.
 *
 * `targets` are `{ id, send(channel, ...args), isDestroyed() }`; in Electron a thin wrapper
 * over a BrowserWindow's webContents. `id` is what the page's answer arrives under
 * (`webContents.id` of the sender).
 */
function createFlushCoordinator(options = {}) {
  const channel = options.channel || "pip:flush-saves";
  const timeoutMs = options.timeoutMs ?? FLUSH_WAIT_MS;
  const log = options.log || (() => {});
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const ready = new Set();
  /** requestId → { waiting: Set<targetId>, answers: Map, done() } */
  const open = new Map();
  let counter = 0;

  function isReady(id) {
    return ready.has(id);
  }

  function setReady(id, value) {
    if (value) ready.add(id);
    else ready.delete(id);
  }

  function answer(senderId, requestId, result) {
    const request = open.get(requestId);
    if (!request || !request.waiting.has(senderId)) return false;
    request.waiting.delete(senderId);
    request.answers.set(senderId, normalise(result));
    if (request.waiting.size === 0) request.done(false);
    return true;
  }

  function normalise(result) {
    if (!result || typeof result !== "object") return { ok: result === true, unsaved: [], names: [] };
    const strings = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === "string") : []);
    const unsaved = strings(result.unsaved);
    // `names` is what a person calls them; a page that gives none is named by its ids.
    return { ok: result.ok === true, unsaved, names: strings(result.names).length ? strings(result.names) : unsaved };
  }

  function ask(targets) {
    const asked = (targets || []).filter((t) => t && ready.has(t.id) && !safely(() => t.isDestroyed(), true));
    if (asked.length === 0) {
      return Promise.resolve({ asked: 0, answered: 0, ok: true, unsaved: [], names: [], timedOut: false });
    }
    const requestId = `flush-${Date.now().toString(36)}-${++counter}`;
    return new Promise((resolve) => {
      let finished = false;
      let timer = null;
      const request = {
        waiting: new Set(asked.map((t) => t.id)),
        answers: new Map(),
        done(timedOut) {
          if (finished) return;
          finished = true;
          if (timer !== null) clearTimer(timer);
          open.delete(requestId);
          const answers = [...request.answers.values()];
          resolve({
            asked: asked.length,
            answered: answers.length,
            ok: !timedOut && answers.every((a) => a.ok),
            unsaved: answers.flatMap((a) => a.unsaved),
            names: answers.flatMap((a) => a.names),
            timedOut,
          });
        },
      };
      open.set(requestId, request);
      timer = setTimer(() => {
        log(`[quit] ${request.waiting.size} window(s) did not answer the flush within ${timeoutMs} ms`);
        request.done(true);
      }, timeoutMs);
      for (const t of asked) {
        try {
          t.send(channel, requestId);
        } catch (e) {
          log(`[quit] could not ask window ${t.id} to flush: ${e && e.message}`);
          request.waiting.delete(t.id);
        }
      }
      if (request.waiting.size === 0) request.done(false);
    });
  }

  return { ask, answer, isReady, setReady, open };
}

function safely(fn, fallback) {
  try {
    return fn();
  } catch (e) {
    return fallback;
  }
}

/**
 * Ask a child process to stop and wait for it to be gone: `signal` (SIGTERM) first, SIGKILL
 * after `waitMs` if it is still there. Resolves `{ exited, killed, ms }` once the child has
 * exited — or, for a child that survives SIGKILL too (it should not), once a second more has
 * gone by, so a quit is never held by it. `child` is a `ChildProcess` (or anything with
 * `kill()`, `once("close"|"exit")` and `exitCode`/`signalCode`).
 */
function stopChild(child, options = {}) {
  const waitMs = options.waitMs ?? STOP_WAIT_MS;
  const signal = options.signal || "SIGTERM";
  const now = options.now || Date.now;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const started = now();
  return new Promise((resolve) => {
    const gone = !child || (child.exitCode !== null && child.exitCode !== undefined) || Boolean(child.signalCode);
    if (gone) {
      resolve({ exited: true, killed: false, ms: 0 });
      return;
    }
    let killed = false;
    let settled = false;
    let killTimer = null;
    let giveUpTimer = null;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      if (killTimer !== null) clearTimer(killTimer);
      if (giveUpTimer !== null) clearTimer(giveUpTimer);
      resolve({ exited, killed, ms: now() - started });
    };
    child.once("exit", () => finish(true));
    child.once("close", () => finish(true));
    safely(() => child.kill(signal));
    killTimer = setTimer(() => {
      if (settled) return;
      killed = true;
      safely(() => child.kill("SIGKILL"));
      giveUpTimer = setTimer(() => finish(false), 1000);
    }, waitMs);
  });
}

/**
 * The quit, in order. `steps` are async functions; each is awaited and none can stop the
 * ones after it (a flush that throws must not leave the backend running), except the
 * person's own answer. Idempotent: a second `run()` while the first is going, or after it,
 * gets the first one's promise.
 *
 *   steps.flush()          land the pages' saves
 *   steps.confirm(flush)   given what the flush said, may the quit go on? `false` is the
 *                          person saying "keep Pip open": nothing after it runs, and the
 *                          next `run()` starts again from the top
 *   steps.hide()           put the windows away
 *   steps.stop()           stop the backend and wait
 *
 * Resolves `{ flush, stop, errors, cancelled }`, each step's own result.
 */
function createQuitSequence(steps, options = {}) {
  const log = options.log || (() => {});
  let running = null;
  return {
    get started() {
      return running !== null;
    },
    /** Forget that the quit ran, so the next `run()` starts again from the top (an update that could not be installed
     *  puts Pip back as it was; the review of A4). */
    reset() {
      running = null;
    },
    run() {
      if (running) return running;
      const mine = (async () => {
        const out = { flush: null, stop: null, errors: [], cancelled: false };
        const step = async (name, fn, ...args) => {
          if (typeof fn !== "function") return null;
          try {
            return await fn(...args);
          } catch (e) {
            out.errors.push(`${name}: ${e && e.message ? e.message : e}`);
            log(`[quit] ${name} failed: ${e && e.message ? e.message : e}`);
            return null;
          }
        };
        out.flush = await step("flush", steps.flush);
        // A confirm that fails to ask lets the quit go: a dialog that cannot be shown must not trap a person in the app.
        if ((await step("confirm", steps.confirm, out.flush)) === false) {
          out.cancelled = true;
          return out;
        }
        await step("hide", steps.hide);
        out.stop = await step("stop", steps.stop);
        return out;
      })();
      running = mine;
      // A quit the person called off is not the quit: the next one starts again.
      mine.then((out) => {
        if (out.cancelled && running === mine) running = null;
      });
      return mine;
    },
  };
}

// ── Asking before changes are lost ─────────────────────────────────────────
//
// If a page says it could not save something (a store refusing saves, a canvas or note the
// backend did not take), quitting loses it. Like a Mac app with unsaved work, Pip asks first,
// with the system's own dialog from the main process: "Some changes couldn't be saved", what
// they are (up to five names) and two buttons, "Keep Pip open" (the default, and what Escape
// does) and "Quit anyway". Only a page's own report counts: a page that did not answer in
// time says nothing about what it held (on a first run the backend can be slow to
// acknowledge a save that is already on disk), and asking about that would be a false alarm.

const QUIT_DIALOG_MESSAGE = "Some changes couldn't be saved";
const QUIT_DIALOG_KEEP = "Keep Pip open";
const QUIT_DIALOG_QUIT = "Quit anyway";
const CLOSE_DIALOG_KEEP = "Keep window open";
const CLOSE_DIALOG_CLOSE = "Close anyway";
const QUIT_DIALOG_NAMES_MAX = 5;

/** The names a flush reported, once each, in order; ids stand in for a page that gave none. */
function unsavedNames(flush) {
  if (!flush || typeof flush !== "object") return [];
  const strings = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === "string" && s) : []);
  const names = strings(flush.names);
  return [...new Set(names.length ? names : strings(flush.unsaved))];
}

/** Does this flush say something was not saved? */
function hasUnsavedWork(flush) {
  return unsavedNames(flush).length > 0;
}

/** "A", "A and B", "A, B and C", and past five "A, B, C, D, E, and 2 more". */
function listNames(names) {
  const shown = names.slice(0, QUIT_DIALOG_NAMES_MAX);
  if (names.length > shown.length) return `${shown.join(", ")}, and ${names.length - shown.length} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/** The options for the native message box. `Keep Pip open` is first, the default and the cancel. */
function quitDialogOptions(flush) {
  return dialogOptions(flush, { keep: QUIT_DIALOG_KEEP, go: QUIT_DIALOG_QUIT, leaving: "quit" });
}

/** The same for a window that is being closed: the page goes with the window, and what it holds goes with it. */
function closeDialogOptions(flush) {
  return dialogOptions(flush, { keep: CLOSE_DIALOG_KEEP, go: CLOSE_DIALOG_CLOSE, leaving: "close the window" });
}

function dialogOptions(flush, { keep, go, leaving }) {
  const names = unsavedNames(flush);
  return {
    type: "warning",
    message: QUIT_DIALOG_MESSAGE,
    detail: `${names.length ? `Changes to ${listNames(names)} weren't saved.` : "Some of what you were working on wasn't saved."} If you ${leaving} now, they will be lost.`,
    buttons: [keep, go],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

/**
 * The question as a step: resolves true to go on, false to keep Pip (or the window) open. `showDialog(options)` is
 * `dialog.showMessageBox` and resolves `{ response }`. Nothing is asked when the flush reported nothing unsaved.
 */
function createConfirm({ showDialog, optionsFor, log = () => {} }) {
  return async function confirm(flush) {
    if (!hasUnsavedWork(flush)) return true;
    try {
      const { response } = await showDialog(optionsFor(flush));
      return response === 1;
    } catch (e) {
      log(`[quit] could not ask about unsaved changes: ${e && e.message}`);
      return true;
    }
  };
}

/** The `confirm` step of the quit. */
function createQuitConfirm({ showDialog, log }) {
  return createConfirm({ showDialog, optionsFor: quitDialogOptions, log });
}

/** The same question when a window is closed, with "Keep window open" and "Close anyway". */
function createCloseConfirm({ showDialog, log }) {
  return createConfirm({ showDialog, optionsFor: closeDialogOptions, log });
}

// ── The system ending the session ──────────────────────────────────────────
//
// A logout, restart or shutdown reaches the app as a quit. Holding that quit (`before-quit`'s `preventDefault`) answers
// the system "no", and cancels the logout or restart (the review of A4; this is Electron's known behaviour on macOS).
// So when the system is ending the session (`powerMonitor`'s `shutdown`), the app lands what it can, asks nothing, and
// never holds the quit.

/** Should this `before-quit` be held until the saves are landed and the backend stopped? */
function shouldHoldQuit({ prepared, systemEnding }) {
  return !prepared && !systemEnding;
}

module.exports = {
  CLOSE_DIALOG_CLOSE,
  CLOSE_DIALOG_KEEP,
  FLUSH_WAIT_MS,
  QUIT_DIALOG_KEEP,
  QUIT_DIALOG_MESSAGE,
  QUIT_DIALOG_QUIT,
  STOP_WAIT_MS,
  closeDialogOptions,
  createCloseConfirm,
  createFlushCoordinator,
  createQuitConfirm,
  createQuitSequence,
  hasUnsavedWork,
  quitDialogOptions,
  shouldHoldQuit,
  stopChild,
  unsavedNames,
};

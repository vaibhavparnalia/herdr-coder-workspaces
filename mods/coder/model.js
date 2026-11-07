// Everything that decides what the Coder panel shows or does lives here, as plain functions.
//
// This module imports nothing: not from the app, and it never reads the clock (callers pass
// `now`), so every rule can be tested with `node --test` (constitution VI).

// ---------------------------------------------------------------------------------------------
// Problems: what went wrong with a `coder` command (contracts/coder-cli.md, "Classifying problems")
// ---------------------------------------------------------------------------------------------

// How `exec` reports a command it stopped at its 30 s limit: it rejects (research.md, step zero S3).
const EXEC_TIMEOUT = /took longer than \d+ s/i;

const SIGNED_OUT = [
  /You are not logged in/i,
  // 401 as an HTTP status, not any 401 in the text (a build number, a port, an id).
  /\bstatus(?: code)?:? 401\b|\bHTTP\/[\d.]+ 401\b|\b401 Unauthorized\b/i,
  /Unauthorized/i,
  /session[^\n]*\b(?:expired|invalid)\b|\b(?:expired|invalid)\b[^\n]*session/i,
];

const UNREACHABLE = /no such host|connection refused|dial tcp|i\/o timeout|context deadline exceeded|\btls\b|certificate/i;

/**
 * What kind of problem a finished `coder` command had, or null when it had none.
 *
 * @param {{ rejected?: boolean, rejectMessage?: string, code?: number, stderr?: string }} outcome
 *   How `exec` settled: `rejected` when it threw (the message is `rejectMessage`), otherwise the
 *   exit `code` and `stderr`.
 * @returns {null | "noCli" | "timeout" | "signedOut" | "unreachable" | "other"}
 */
export function classifyProblem({ rejected, rejectMessage, code, stderr } = {}) {
  // A rejection is the program not starting, or exec stopping it. Only the message tells them apart.
  if (rejected) return EXEC_TIMEOUT.test(rejectMessage ?? "") ? "timeout" : "noCli";
  if (code === 0) return null;
  const text = stderr ?? "";
  if (SIGNED_OUT.some((signal) => signal.test(text))) return "signedOut";
  if (UNREACHABLE.test(text)) return "unreachable";
  return "other";
}

/** The last non-empty line of some text, trimmed: the reason a command failed. "" when there is none. */
export function lastLine(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

// ---------------------------------------------------------------------------------------------
// Workspaces: `coder list --output json`, normalized (data-model.md, "Workspace")
// ---------------------------------------------------------------------------------------------

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const text = (value) => (typeof value === "string" ? value : "");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Coder writes times with microseconds ("...00.123456Z"); not every JS engine reads more than
// three fractional digits, so cut them. Go's zero time, and anything unreadable, is "no time".
function toDate(value) {
  if (typeof value !== "string" || value === "" || value.startsWith("0001-01-01")) return null;
  const date = new Date(value.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(date.getTime()) ? null : date;
}

// Coder's own rule for user and workspace names. A name that breaks it can't come from a genuine
// server, and one that starts with "-" would reach `coder` as an option, so such a workspace is
// left out rather than acted on.
const CODER_NAME = /^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/;

function normalizeOne(entry, nowMs) {
  if (!isObject(entry)) return null;
  const name = text(entry.name);
  const owner = text(entry.owner_name);
  // Without both parts of its name there is nothing an action could safely be pointed at.
  if (!CODER_NAME.test(name) || !CODER_NAME.test(owner)) return null;

  const build = isObject(entry.latest_build) ? entry.latest_build : {};
  const job = isObject(build.job) ? build.job : {};
  const status = text(build.status) || "unknown";
  if (status === "deleted") return null;

  // A deadline counts only while the workspace is running (a stopped one keeps its last run's)
  // and only until it passes: after that the workspace is about to stop.
  const stopTime = toDate(build.deadline);
  const live = status === "running" && stopTime !== null;
  const deadline = live && stopTime.getTime() > nowMs ? stopTime : null;

  return {
    id: text(entry.id),
    owner,
    name,
    ref: `${owner}/${name}`,
    template: text(entry.template_display_name).trim() || text(entry.template_name),
    status,
    outdated: entry.outdated === true,
    healthy: !(isObject(entry.health) && entry.health.healthy === false),
    deadline,
    deadlinePassed: live && deadline === null,
    maxDeadline: toDate(build.max_deadline),
    ttlMs: typeof entry.ttl_ms === "number" ? entry.ttl_ms : null,
    build: {
      number: typeof build.build_number === "number" ? build.build_number : 0,
      transition: text(build.transition) || null,
      createdAt: toDate(build.created_at),
      reason: text(build.reason) || null,
      jobStatus: text(job.status) || null,
      error: text(job.error).trim() ? job.error : null,
      queuePosition: typeof job.queue_position === "number" ? job.queue_position : 0,
    },
  };
}

/**
 * The workspaces in a `coder list --output json` answer, as the panel works with them.
 * Workspaces that were deleted, or that cannot be named, are left out. Never throws.
 *
 * @param {unknown} list the parsed JSON
 * @param {Date} now what time it is
 */
export function normalizeWorkspaces(list, now) {
  if (!Array.isArray(list)) return [];
  const nowMs = now.getTime();
  return list.map((entry) => normalizeOne(entry, nowMs)).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// Rows: what each workspace looks like (data-model.md, "State groups and order", "Row detail")
// ---------------------------------------------------------------------------------------------

// Each state's look is one of Coder's status kinds, as its dashboard shows them: a tone (success,
// pending, inactive, warning, failed; look.js gives each its theme color) and whether its dot
// moves, which only work in progress does.
const kind = (tone, moving = false) => Object.freeze({ tone, moving });
const STILL_GREY = kind("inactive");
// The dashboard shows a workspace whose agents are unhealthy in its warning kind.
const UNHEALTHY = kind("warning");

// status -> its group, sort rank, indicator and word
const LOOKS = {
  running: { group: "running", rank: 0, indicator: kind("success"), word: "Running" },
  starting: { group: "progress", rank: 0, indicator: kind("pending", true), word: "Starting…" },
  pending: { group: "progress", rank: 1, indicator: kind("pending", true), word: "Queued…" },
  stopping: { group: "progress", rank: 1, indicator: kind("inactive", true), word: "Stopping…" },
  canceling: { group: "progress", rank: 1, indicator: kind("inactive", true), word: "Canceling…" },
  deleting: { group: "progress", rank: 1, indicator: kind("warning", true), word: "Deleting…" },
  stopped: { group: "stopped", rank: 2, indicator: STILL_GREY, word: "Stopped" },
  canceled: { group: "stopped", rank: 2, indicator: STILL_GREY, word: "Canceled" },
  failed: { group: "failed", rank: 2, indicator: kind("failed"), word: "Failed" },
};

// A status this version has never heard of is shown as stopped, in its own words, not hidden.
function lookOf(status) {
  return LOOKS[status] ?? { group: "stopped", rank: 2, indicator: STILL_GREY, word: status.charAt(0).toUpperCase() + status.slice(1) };
}

const pad2 = (n) => String(n).padStart(2, "0");

/** A time left, for people: "7h 42m", "42m", "<1m". */
export function formatCountdown(ms) {
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  return hours >= 1 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

// Time a build has run, as m:ss. Minutes keep counting past an hour.
function formatElapsed(ms) {
  const seconds = Math.floor(Math.max(0, ms) / SECOND);
  return `${Math.floor(seconds / 60)}:${pad2(seconds % 60)}`;
}

// How long ago, as "<1m", "35m", "5h" or "13d".
function formatAge(ms) {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function firstLine(value) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

const WARN_UNDER = 10 * MINUTE;

function detailOf(ws, group, nowMs) {
  const created = ws.build.createdAt;
  if (group === "running") {
    if (ws.deadline) {
      // The deadline may have passed since the list was read.
      const left = ws.deadline.getTime() - nowMs;
      if (left > 0) {
        // When the template's limit is why +1h is not offered, the row says so.
        const limit = extendPlan(ws, new Date(nowMs)).atLimit ? " · at limit" : "";
        return { detail: `stops in ${formatCountdown(left)}${limit}`, warning: left < WARN_UNDER };
      }
      return { detail: "about to stop", warning: true };
    }
    if (ws.deadlinePassed) return { detail: "about to stop", warning: true };
    return { detail: "no auto-stop", warning: false };
  }
  if (group === "progress") {
    const elapsed = formatElapsed(created ? nowMs - created.getTime() : 0);
    const queue = ws.build.queuePosition > 0 ? ` · queued #${ws.build.queuePosition}` : "";
    return { detail: elapsed + queue, warning: false };
  }
  if (group === "failed") {
    const reason = firstLine(ws.build.error);
    return { detail: `build #${ws.build.number}${reason ? ` · ${reason}` : ""}`, warning: false };
  }
  return { detail: created ? `last built ${formatAge(nowMs - created.getTime())} ago` : "", warning: false };
}

function compareRows(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// What the panel remembers about a workspace may be kept in a Map or a plain object, by id.
const recall = (memory, id) => (memory instanceof Map ? memory.get(id) : memory?.[id]);

// While an action is pending, its row looks like the build it started: Start and Update like a
// start, Stop like a stop. That is also where the row sorts.
const PENDING_LOOK = { start: LOOKS.starting, stop: LOOKS.stopping, update: LOOKS.starting };

/**
 * The rows to draw, in order: what each workspace says, and what can be done to it.
 *
 * `now` says what time it is. `state` is the panel's own memory of each workspace, by its id:
 * `actions` (an action the person started, which overrides how the row looks and hides its
 * buttons, FR-013), `errors` (the last failure to show under the row) and, in later features,
 * `forwards`.
 */
export function toRows(workspaces, now, state = {}) {
  const nowMs = now.getTime();
  return workspaces
    .map((ws) => {
      const found = recall(state.actions, ws.id);
      const pending = found && found.state === "pending" ? found : null;
      const word = pending ? pendingWord(pending.kind) : null;
      const look = word ? PENDING_LOOK[pending.kind] : lookOf(ws.status);
      const { detail, warning } = word
        ? { detail: formatElapsed(nowMs - pending.pressedAt.getTime()), warning: false }
        : detailOf(ws, look.group, nowMs);
      const unhealthy = ws.status === "running" && !ws.healthy;
      const tags = [];
      if (ws.outdated) tags.push("outdated");
      if (unhealthy) tags.push("unhealthy");
      return {
        id: ws.id,
        ref: ws.ref,
        name: ws.name,
        template: ws.template,
        avatar: avatarText(ws.template || ws.name),
        status: ws.status,
        group: look.group,
        rank: look.rank,
        // A pending action looks like its build; otherwise an unhealthy running workspace is a warning.
        indicator: { ...(unhealthy && !word ? UNHEALTHY : look.indicator) },
        word: word ?? look.word,
        detail,
        warning,
        tags,
        actions: rowActions(ws, { pending: Boolean(pending), now }),
        forwards: forwardChips(state.forwards, ws.ref),
        error: recall(state.errors, ws.id) ?? null,
      };
    })
    .sort(compareRows);
}

// Graphemes where the engine can split them; the app's engine has no Intl, so there it is code points.
const GRAPHEMES = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null;

/**
 * The two characters a row's avatar shows: the first two of `text`, in capitals, as Coder's
 * dashboard shows a template that has no icon. An emoji counts as one character where the engine
 * can tell (`segmenter`); otherwise each code point counts. "-" when there is nothing to show.
 */
export function avatarText(text, { segmenter = GRAPHEMES } = {}) {
  const name = typeof text === "string" ? text.trim() : "";
  const characters = segmenter ? Array.from(segmenter.segment(name), (part) => part.segment) : Array.from(name);
  return characters.slice(0, 2).join("").trim().toUpperCase() || "-";
}

// ---------------------------------------------------------------------------------------------
// The panel as a whole (data-model.md, "Deployment" and "Panel state"; contracts/ui.md)
// ---------------------------------------------------------------------------------------------

/** The deployment the person is signed in to, from `coder whoami --output json`; null if unknown. */
export function parseWhoami(json) {
  const first = Array.isArray(json) ? json[0] : null;
  const url = text(first?.url).trim().replace(/\/+$/, "");
  const username = text(first?.username).trim();
  if (!url || !username) return null;
  return { url, username, host: url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "") };
}

/** The arguments that read from Coder. */
export const listArgs = () => ["list", "--output", "json"];
export const whoamiArgs = () => ["whoami", "--output", "json"];

/**
 * How long to wait before the next refresh: 3 s while something is in progress (a build, a
 * pending action, a forward starting), otherwise 30 s. It never goes faster when idle, and
 * never after a failed refresh (`failed`).
 */
export function nextRefreshDelay({ rows, pendingActions, startingForwards, failed } = {}) {
  // After a failed refresh nothing is really progressing: the old list is only out of date.
  if (failed) return 30 * SECOND;
  const busy = (rows ?? []).some((row) => row.group === "progress") || pendingActions > 0 || startingForwards > 0;
  return busy ? 3 * SECOND : 30 * SECOND;
}

/**
 * What a Refresh does (FR-010, SC-004, Principle IV). With none running it `start`s one.
 * While one runs, it `queue`s one more, to start as soon as that one ends; if one is queued
 * already it only `acknowledge`s the press, so two never run and none is queued twice. The refresh
 * `timer` firing mid-read `skip`s: the read under way schedules the next. A closing panel `skip`s.
 *
 * @param {{ refreshing?: boolean, queued?: boolean, closing?: boolean, timer?: boolean }} input
 * @returns {"start" | "queue" | "acknowledge" | "skip"}
 */
export function decideRefresh({ refreshing = false, queued = false, closing = false, timer = false } = {}) {
  if (closing) return "skip";
  if (!refreshing) return "start";
  if (timer) return "skip";
  return queued ? "acknowledge" : "queue";
}

/** The workspace selected when the panel opens: the one saved last time if it is still there, else the first. */
export function initialSelection(rows, savedRef) {
  if (savedRef && rows.some((row) => row.ref === savedRef)) return savedRef;
  return rows.length ? rows[0].ref : null;
}

/** The selection moved by `delta` rows, stopping at the ends. From nothing, the first row. */
export function moveSelection(rows, ref, delta) {
  if (!rows.length) return null;
  const at = rows.findIndex((row) => row.ref === ref);
  if (at < 0) return rows[0].ref;
  return rows[Math.min(rows.length - 1, Math.max(0, at + delta))].ref;
}

/** The header's freshness note: the clock time (24-hour, local) of the last good refresh. */
export function updatedLabel(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return `updated ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * The header's second line: `{ host, user }` where the person is signed in, or `{ problem }` when
 * Coder's list answers but `coder whoami` did not (`who` is its last outcome), so the person knows
 * why links cannot open yet; null when there is nothing to say. While the list itself fails, the
 * panel's own problem says it all.
 */
export function accountLine({ deployment, who, listOk }) {
  if (deployment) return { host: deployment.host, user: deployment.username };
  if (!listOk || !who || who.ok) return null;
  return { problem: who.message ? `Couldn't read who is signed in: ${who.message}` : "Couldn't read who is signed in." };
}

function problemFor(kind, message, deployment) {
  const url = deployment?.url;
  switch (kind) {
    case "noCli":
      return { kind, message: "The Coder command-line tool isn't installed.", detail: "", hint: "Install it, then press R to refresh." };
    case "signedOut":
      return { kind, message: "Not signed in to Coder.", detail: "", hint: `Run coder login${url ? ` ${url}` : ""} in a terminal, then press R.` };
    case "unreachable":
      return { kind, message: `Can't reach ${deployment?.host ?? "Coder"}.`, detail: message || "", hint: "Check your connection or VPN, then press R to retry." };
    default:
      return { kind: "other", message: message || "Something went wrong running coder.", detail: "", hint: "Fix the problem, then press R to retry." };
  }
}

/**
 * What the panel shows as a whole: loading, the rows, or a problem.
 *
 * @param {{ outcome: null | { ok: true, workspaces: object[] } | { ok: false, problem: string, message: string },
 *           previous: null | { workspaces: object[] }, deployment?: object | null, now: Date, state?: object }} input
 *   `outcome` is how the latest refresh ended (null before the first one ends); `previous` is the
 *   last good list; `state` is what `toRows` takes (pending actions, row messages). A problem
 *   keeps the earlier list, marked out of date, and offers no actions on it: nothing is pressed
 *   on what cannot be seen.
 *   `state.refreshing` says a refresh is under way, which the header shows (FR-009).
 * @returns {{ phase: "loading" | "ready" | "problem", problem: object | null, stale: boolean, refreshing: boolean, rows: object[] }}
 */
export function panelView({ outcome, previous, deployment, now, state } = {}) {
  const rowsFor = (list) => (list?.workspaces ? toRows(list.workspaces, now, state) : []);
  const refreshing = Boolean(state?.refreshing);
  if (!outcome) {
    return previous
      ? { phase: "ready", problem: null, stale: false, refreshing, rows: rowsFor(previous) }
      : { phase: "loading", problem: null, stale: false, refreshing, rows: [] };
  }
  if (outcome.ok) return { phase: "ready", problem: null, stale: false, refreshing, rows: rowsFor(outcome) };
  // A list that took 30 s is as good as unreachable.
  const kind = outcome.problem === "timeout" ? "unreachable" : outcome.problem;
  return {
    phase: "problem",
    problem: problemFor(kind, outcome.message, deployment),
    stale: Boolean(previous),
    refreshing,
    rows: rowsFor(previous).map((row) => ({ ...row, actions: [] })),
  };
}

// ---------------------------------------------------------------------------------------------
// Actions: what a row offers, the commands, and how an action ends (data-model.md, "Workspace action")
// ---------------------------------------------------------------------------------------------

const IN_PROGRESS = new Set(["starting", "pending", "stopping", "canceling", "deleting"]);

/**
 * The actions a workspace's row offers, in the order their buttons appear. Each has an `id`, the
 * `letter` that runs it from the keyboard, and `confirm: true` when it asks first (constitution II).
 * A row offers nothing while its own action is pending, or while the workspace is in progress.
 */
export function rowActions(ws, { pending = false, now = null } = {}) {
  if (pending || IN_PROGRESS.has(ws.status)) return [];
  const running = ws.status === "running";
  const idle = ws.status === "stopped" || ws.status === "failed" || ws.status === "canceled";
  const actions = [];
  if (idle) actions.push({ id: "start", letter: "s" });
  if (running) {
    actions.push({ id: "stop", letter: "x", confirm: true });
    actions.push({ id: "vscode", letter: "v" });
    // +1h depends on what time it is: without the clock it is not offered, never guessed.
    if (now && extendPlan(ws, now).offered) actions.push({ id: "extend", letter: "e" });
    actions.push({ id: "forward", letter: "p" });
  }
  // Update restarts a running workspace, so that asks first (FR-014). A status this version has never heard of offers none of this.
  if (ws.outdated && (running || idle)) actions.push(running ? { id: "update", letter: "u", confirm: true } : { id: "update", letter: "u" });
  actions.push({ id: "open", letter: "o" });
  if (ws.status === "failed") actions.push({ id: "log", letter: "l" });
  return actions;
}

/** `coder open vscode`: VS Code opens connected to the workspace. */
export const vscodeArgs = (ref) => ["open", "vscode", ref];

/**
 * Update keeps current values and takes defaults only for settings that are new (research R6): the
 * person has asked for the new version. A workspace that is running is stopped, then started.
 */
export const updateArgs = (ref) => ["update", "--use-parameter-defaults", ref];

// ---------------------------------------------------------------------------------------------
// +1h (data-model.md, "+1h (FR-018)")
// ---------------------------------------------------------------------------------------------

const EXTEND_BY = 60 * MINUTE;
const EXTEND_MIN_AHEAD = 30 * MINUTE;

/**
 * What +1h would do to a workspace right now. Coder counts the amount it is given from now, not
 * from the stop time, so a plain 60 minutes would shorten any countdown longer than an hour:
 * the amount is worked out from the stop time instead.
 *
 * Returns `{ offered, remaining, target, minutes, clamped, atLimit }`:
 *  - `remaining`: whole minutes until the stop time, rounded up;
 *  - `target`: the new stop time, an hour after the old, but never past the template's limit;
 *  - `minutes`: what to give Coder, whole minutes from now rounded up, so +1h is never short;
 *  - `offered`: the new stop time is later than the old and at least 30 minutes away;
 *  - `clamped`: the limit cut the hour short;
 *  - `atLimit`: there is a stop time, and the limit is why +1h is not offered.
 * A workspace with no stop time to move (none, passed, not running) gets nothing offered.
 *
 * @param {object} ws a workspace from `normalizeWorkspaces`
 * @param {Date} now what time it is
 */
export function extendPlan(ws, now) {
  const nowMs = now.getTime();
  const none = { offered: false, remaining: null, target: null, minutes: null, clamped: false, atLimit: false };
  if (!ws?.deadline || ws.deadline.getTime() <= nowMs) return none;

  const deadlineMs = ws.deadline.getTime();
  const wanted = deadlineMs + EXTEND_BY;
  const limit = ws.maxDeadline ? ws.maxDeadline.getTime() : null;
  const targetMs = limit === null ? wanted : Math.min(wanted, limit);
  const offered = targetMs > deadlineMs && targetMs >= nowMs + EXTEND_MIN_AHEAD;
  return {
    offered,
    remaining: Math.ceil((deadlineMs - nowMs) / MINUTE),
    target: new Date(targetMs),
    minutes: offered ? Math.ceil((targetMs - nowMs) / MINUTE) : null,
    clamped: targetMs < wanted,
    atLimit: !offered,
  };
}

/** `coder schedule extend`: the stop time moves to `minutes` from now. */
export const extendArgs = (ref, minutes) => ["schedule", "extend", ref, `${minutes}m`];

/**
 * Start does not wait for the build, and gives Coder no answers on the person's behalf: no
 * `--yes`, no `--use-parameter-defaults`. If Coder needs an answer the start fails, and the row says why.
 */
export const startArgs = (ref) => ["start", "--no-wait", ref];

/** Stop waits for the build (a few seconds). `-y` only because the panel has already asked. */
export const stopArgs = (ref) => ["stop", "-y", ref];

/** How long an action may show no change before the row says so (FR-016). */
export const NO_CHANGE_MS = 90 * SECOND;

// The build transition that finishes an action. Update ends on the start build that follows its stop.
const FINISHES_WITH = { start: "start", stop: "stop", update: "start" };
const PENDING_WORDS = { start: "Starting…", stop: "Stopping…", update: "Updating…" };

/** What a row says while the action runs, or null for an action that has no wait to show. */
export const pendingWord = (kind) => PENDING_WORDS[kind] ?? null;

/** The note of what was pressed: when, and which build the workspace was on. */
export function beginAction(kind, ws, now) {
  return { kind, state: "pending", pressedAt: now, fromBuild: ws.build.number };
}

function failureReason(build) {
  if (build.jobStatus === "canceled") return "The build was canceled.";
  return firstLine(build.error) || "The build failed.";
}

/**
 * Where an action stands, given the workspace as the latest list shows it (null if it is gone)
 * and how the command ended (`{ ok }`, `{ pending }` when exec's 30 s limit stopped waiting, or
 * `{ error }`). The result is a new action, in state:
 *
 *  - `pending`: nothing to report yet;
 *  - `done`: a newer build of the right kind has finished;
 *  - `failed`, with a `message`: that build failed or was canceled, or the command exited non-zero;
 *  - `noChange`: 90 s with no newer build in progress;
 *  - `dropped`: the workspace is no longer listed.
 *
 * The command's own success never finishes an action: only the build does (research R3).
 */
export function settleAction(action, ws, now, execOutcome = action.exec) {
  if (action.state !== "pending") return action;
  if (!ws) return { ...action, state: "dropped" };
  if (execOutcome?.error) return { ...action, state: "failed", message: execOutcome.error };

  // Actions with no build to wait for end when their command does.
  if (!(action.kind in FINISHES_WITH)) return execOutcome?.ok ? { ...action, state: "done" } : action;

  const build = ws.build;
  const newer = build.number > action.fromBuild;
  const finished = build.jobStatus === "succeeded" || build.jobStatus === "failed" || build.jobStatus === "canceled";
  if (newer && finished) {
    // Whatever build came next, if it failed the action did.
    if (build.jobStatus !== "succeeded") return { ...action, state: "failed", message: failureReason(build) };
    if (build.transition === FINISHES_WITH[action.kind]) return { ...action, state: "done" };
  }
  const building = newer && (build.jobStatus === "pending" || build.jobStatus === "running" || build.jobStatus === "canceling");
  if (now.getTime() - action.pressedAt.getTime() >= NO_CHANGE_MS && !building) {
    return { ...action, state: "noChange", message: "No change yet. Check the dashboard ↗" };
  }
  return action;
}

/**
 * Settles every pending action against the latest list. Actions on different workspaces never
 * wait for each other (FR-024). Returns the actions still pending, and an event for each that
 * ended, to be shown once: `{ id, ref, name, kind, state, message }`.
 *
 * @param {{ actions: Map | object, workspaces: object[], now: Date }} input actions by workspace id
 */
export function reconcileActions({ actions, workspaces, now }) {
  const byId = new Map(workspaces.map((ws) => [ws.id, ws]));
  const remaining = {};
  const events = [];
  const entries = actions instanceof Map ? [...actions] : Object.entries(actions ?? {});
  for (const [id, action] of entries) {
    const ws = byId.get(id) ?? null;
    const settled = settleAction(action, ws, now);
    if (settled.state === "pending") {
      remaining[id] = action;
    } else {
      events.push({
        id,
        ref: ws?.ref ?? null,
        name: ws?.name ?? null,
        kind: action.kind,
        state: settled.state,
        message: settled.message ?? null,
        ...(action.clamped ? { clamped: true } : {}),
      });
    }
  }
  return { actions: remaining, events };
}

const NOTICES = {
  start: { done: (name) => `${name} is running`, verb: "start" },
  stop: { done: (name) => `${name} stopped`, verb: "stop" },
  update: { done: (name) => `${name} updated`, verb: "update" },
};

/** The notification for an action that ended, or null when it is not one (FR-015). */
export function actionNotice({ kind, state, name, message }) {
  const words = NOTICES[kind];
  if (!words) return null;
  if (state === "done") return { title: words.done(name), level: "success" };
  if (state === "failed") return { title: `Couldn't ${words.verb} ${name}`, ...(message ? { body: message } : {}), level: "error" };
  return null;
}

const QUESTIONS = {
  stop: (name) => ({ text: `Stop ${name}? Anything running in it ends.`, confirmLabel: "Stop" }),
  update: (name) => ({ text: `Update ${name}? It restarts on the new version.`, confirmLabel: "Update" }),
};

/** What a row asks before an action that ends or interrupts work (FR-014), or null for one that does not ask. */
export const confirmText = (kind, name) => QUESTIONS[kind]?.(name) ?? null;

/**
 * What an ended action leaves under its row until the person dismisses it, or null: a failure is
 * an `error`; no change yet is a `note` that leads to the workspace's page.
 */
export function rowErrorFor({ kind, state, message, clamped }, ws = null, now = null) {
  if (state === "failed") return { text: message || "It did not work.", tone: "error", link: null };
  if (kind === "extend" && state === "done" && clamped) {
    // The workspace is the one from the list read after the command, so its stop time is the new one.
    const left = ws?.deadline && now ? ws.deadline.getTime() - now.getTime() : 0;
    const stops = left > 0 ? ` (stops in ${formatCountdown(left)})` : "";
    return { text: `Extended to the template's limit${stops}.`, tone: "note", link: null };
  }
  if (state === "noChange") return { text: "No change yet.", tone: "note", link: { label: "Check the dashboard ↗", page: "workspace" } };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Port forwards (data-model.md, "Port forward"; research.md R2, R13)
// ---------------------------------------------------------------------------------------------

/** What the port box says when it cannot read what was typed (FR-019). */
export const PORT_INPUT_MESSAGE = "Enter a port (3000) or local:workspace (8080:3000).";

function parsePort(text) {
  if (!/^\d+$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * Reads what was typed in the port box: `N` is port N here to port N there, `L:R` is port L here
 * to port R in the workspace. Each must be a whole number from 1 to 65535. Returns
 * `{ ok: true, local, remote }` or `{ ok: false, message }`.
 */
export function parsePortInput(text) {
  const bad = { ok: false, message: PORT_INPUT_MESSAGE };
  if (typeof text !== "string") return bad;
  const parts = text.trim().split(":");
  if (parts.length > 2) return bad;
  const local = parsePort(parts[0]);
  const remote = parts.length === 2 ? parsePort(parts[1]) : local;
  return local === null || remote === null ? bad : { ok: true, local, remote };
}

/** The label a forward's terminal carries, which is how it is found again: `alice/api@8080:3000`. */
export const forwardLabel = (ref, local, remote) => `${ref}@${local}:${remote}`;

/** Reads a forward's label back: `{ ref, local, remote }`, or null when it is not one. */
export function parseForwardLabel(label) {
  const match = typeof label === "string" ? /^([^/@\s]+\/[^/@\s]+)@(\d+):(\d+)$/.exec(label) : null;
  if (!match) return null;
  const local = parsePort(match[2]);
  const remote = parsePort(match[3]);
  return local === null || remote === null ? null : { ref: match[1], local, remote };
}

/**
 * The running forwards of one workspace, in the order of their local ports: the live terminals
 * (`terminals()`) that carry its label. A terminal that has finished is not in that list at all
 * (step zero S2), so a failed forward is told apart by its absence (`forwardState`).
 * Each is `{ address, ref, local, remote, createdAt }`.
 */
export function findForwards(terminals, ref) {
  if (!Array.isArray(terminals)) return [];
  const found = [];
  for (const terminal of terminals) {
    if (!isObject(terminal) || terminal.state !== "live" || !isObject(terminal.labels)) continue;
    const parsed = parseForwardLabel(terminal.labels["coder.forward"]);
    if (!parsed || parsed.ref !== ref) continue;
    const created = typeof terminal.created_ms === "number" ? new Date(terminal.created_ms) : null;
    found.push({ address: terminal.address, ref, local: parsed.local, remote: parsed.remote, createdAt: created });
  }
  return found.sort((a, b) => a.local - b.local || a.remote - b.remote);
}

/**
 * The space a forward's tab goes to, only ever on this computer: one named "Coder", else the first
 * there is, else `{ id: null }` for the caller to make one.
 */
export function pickForwardSpace(spaces) {
  const here = Array.isArray(spaces) ? spaces.filter((space) => isObject(space) && space.machine === null) : [];
  const chosen = here.find((space) => space.name === "Coder") ?? here[0];
  return { id: chosen ? chosen.id : null };
}

/** A fresh id for a tab or a space: the prefix and 32 hex digits, each from `random()` (0 up to, not past, 1). */
export function freshId(prefix, random) {
  let id = prefix;
  for (let i = 0; i < 32; i += 1) id += Math.min(15, Math.floor(random() * 16)).toString(16);
  return id;
}

/**
 * The `hc` arguments that start a forward in the background, on this computer, as a tab of the
 * given space. Never `--on`; `--disable-autostart` so it can never start a stopped workspace.
 *
 * The program is `/usr/bin/env coder`, not the bare word `coder`: `hc run` starts a template
 * instead of a program when its first word names one, and a person's `coder` template would
 * have taken the forward's place. A path can't be a template's name.
 */
export function forwardRunArgs({ spaceId, tabId, ref, local, remote, home }) {
  return [
    "run", "--bg", "--json", "--no-parent", "--no-notify", "--cwd", home,
    "--label", `herdr.space=${spaceId}`,
    "--label", `herdr.tab=${tabId}`,
    "--label", `coder.forward=${forwardLabel(ref, local, remote)}`,
    "--", "/usr/bin/env", "coder", "port-forward", ref, "--tcp", `${local}:${remote}`, "--disable-autostart",
  ];
}

/** What the forward's tab is called. */
export const forwardTabName = (name, local) => `${name} :${local}`;

/** How long after it starts a forward counts as starting, and a finish as a failure to start. */
export const FORWARD_START_MS = 10 * SECOND;

/**
 * How a forward is doing: `starting`, `running`, `failed` or `ended`.
 *
 * `forward` is what the panel knows (`startedAt`, or nothing for a forward it did not start) and
 * `terminal` what herdr-core says of it: from `terminals()` while it lives, or from `hc get` once
 * it has finished (`finished_ms`, `exit_code`), or null when it is gone. A terminal that exited on
 * its own within 10 s of starting is `failed`; a later finish, a kill, or being gone is `ended`.
 * It is timed by its own clock readings, not by when the panel noticed.
 */
export function forwardState(forward, terminal, now) {
  if (!isObject(terminal)) return "ended";
  const created = forward?.startedAt ? forward.startedAt.getTime() : typeof terminal.created_ms === "number" ? terminal.created_ms : null;
  if (terminal.state === "live") {
    return created !== null && now.getTime() - created < FORWARD_START_MS ? "starting" : "running";
  }
  if (terminal.state === "finished" && typeof terminal.exit_code === "number" && created !== null) {
    const finished = typeof terminal.finished_ms === "number" ? terminal.finished_ms : now.getTime();
    if (finished - created < FORWARD_START_MS) return "failed";
  }
  return "ended";
}

/** How long the panel watches a forward it started, at most, should the app never say how it is. */
export const FORWARD_GIVE_UP_MS = 60 * SECOND;

/** Whether the watch has given `forward` up: a minute has passed since it started. */
export const forwardGivenUp = (forward, now) => now.getTime() - forward.startedAt.getTime() >= FORWARD_GIVE_UP_MS;

/**
 * The renames due now for a forward that is starting: `{ tab, space }`, each an id or null.
 *
 * Nothing is due until `spaces` (what `spaces()` lists) shows the forward's tab, because a rename
 * sent before then does nothing (step zero S2). The tab is renamed once. The space is renamed only
 * when it was made for the forward (`newSpace`), and is found by the tab it holds rather than by
 * the id the mod asked for; a space that was there before the forward started (`spacesBefore`) is
 * never renamed, so the person's own space can never be.
 */
export function forwardRenames(forward, spaces) {
  const holds = (space) => isObject(space) && Array.isArray(space.tabs) && space.tabs.some((tab) => isObject(tab) && tab.id === forward.tabId);
  const space = Array.isArray(spaces) ? spaces.find(holds) : undefined;
  if (!space) return { tab: null, space: null };
  const before = Array.isArray(forward.spacesBefore) ? forward.spacesBefore : [];
  return {
    tab: forward.tabRenamed ? null : forward.tabId,
    space: forward.newSpace && !forward.spaceRenamed && !before.includes(space.id) ? space.id : null,
  };
}

/**
 * The forwards still starting when the panel closes (address -> what the panel knows), as plain
 * values `shared()` can keep: the next panel watches them on, so one that fails just after the
 * panel closed is still read, reported and removed.
 */
export function saveForwards(starting) {
  return [...starting].map(([address, f]) => ({
    address,
    id: f.id,
    ref: f.ref,
    local: f.local,
    remote: f.remote,
    startedAt: f.startedAt.getTime(),
    spaceId: f.spaceId ?? null,
    tabId: f.tabId ?? null,
    newSpace: Boolean(f.newSpace),
    tabName: f.tabName ?? "",
    tabRenamed: Boolean(f.tabRenamed),
    spaceRenamed: Boolean(f.spaceRenamed),
    spacesBefore: Array.isArray(f.spacesBefore) ? [...f.spacesBefore] : [],
  }));
}

/** What `saveForwards` kept, as `[address, forward]` pairs again; anything that cannot be read is left out. */
export function restoreForwards(value) {
  if (!Array.isArray(value)) return [];
  const isPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;
  const restored = [];
  for (const f of value) {
    if (!isObject(f) || !text(f.address) || !text(f.id) || !text(f.ref) || !isPort(f.local) || !isPort(f.remote) || !Number.isFinite(f.startedAt)) continue;
    restored.push([
      f.address,
      {
        address: f.address,
        id: f.id,
        ref: f.ref,
        local: f.local,
        remote: f.remote,
        startedAt: new Date(f.startedAt),
        spaceId: text(f.spaceId) || null,
        tabId: text(f.tabId) || null,
        newSpace: f.newSpace === true,
        tabName: text(f.tabName),
        tabRenamed: f.tabRenamed === true,
        spaceRenamed: f.spaceRenamed === true,
        spacesBefore: Array.isArray(f.spacesBefore) ? f.spacesBefore.filter((id) => typeof id === "string") : [],
      },
    ]);
  }
  return restored;
}

// The chips under a row: its forwards that are starting or running, in port order.
function forwardChips(forwards, ref) {
  if (!Array.isArray(forwards)) return [];
  return forwards
    .filter((f) => f.ref === ref && (f.state === "starting" || f.state === "running"))
    .sort((a, b) => a.local - b.local || a.remote - b.remote)
    .map((f) => ({ address: f.address, local: f.local, remote: f.remote, starting: f.state === "starting" }));
}

// ---------------------------------------------------------------------------------------------
// Escape
// ---------------------------------------------------------------------------------------------

/** One press of Escape can arrive twice, by the panel's key handler and by the `coder.close` binding: this long is "the same press". */
export const ESCAPE_REPEAT_MS = 200;

/**
 * What Escape does: `cancel` the open question, else `close` the panel (FR-001, FR-033). A second
 * delivery of the press that has just cancelled a question is `ignore`d, so it cannot close the
 * panel the person only meant to step back from.
 *
 * @param {{ hasPrompt: boolean, cancelledAt: Date | null, now: Date }} input
 */
export function decideEscape({ hasPrompt, cancelledAt, now }) {
  if (hasPrompt) return "cancel";
  if (cancelledAt && now.getTime() - cancelledAt.getTime() < ESCAPE_REPEAT_MS) return "ignore";
  return "close";
}

// ---------------------------------------------------------------------------------------------
// Links (contracts/coder-cli.md, "Opening links")
// ---------------------------------------------------------------------------------------------

/** Where to get the Coder command-line tool. */
export const INSTALL_URL = "https://coder.com/docs/install";

/** The deployment's dashboard, or null when its address is not known. */
export const dashboardUrl = (deployment) => deployment?.url || null;

/** A workspace's page on the dashboard. */
export function workspaceUrl(deployment, ws) {
  const base = dashboardUrl(deployment);
  return base ? `${base}/@${encodeURIComponent(ws.owner)}/${encodeURIComponent(ws.name)}` : null;
}

/** The page of a workspace's latest build, which has its log. */
export function buildUrl(deployment, ws) {
  const page = workspaceUrl(deployment, ws);
  return page ? `${page}/builds/${ws.build.number}` : null;
}

/** The page an action opens: Open the workspace's, Build log its last build's; null for any other action. */
export function actionUrl(deployment, ws, id) {
  if (id === "open") return workspaceUrl(deployment, ws);
  if (id === "log") return buildUrl(deployment, ws);
  return null;
}

/**
 * The program and arguments that open a link in the default browser on this platform. Only a
 * web link is ever handed to the opener: anything else (a file, a script, something that looks
 * like an option) gives null.
 */
export function openArgs(platform, url) {
  if (typeof url !== "string" || !/^https?:\/\/\S+$/i.test(url)) return null;
  return { cmd: platform === "macos" ? "open" : "xdg-open", args: [url] };
}

// Every call the panel makes to the outside: the `coder` command-line tool, and herdr-core.
//
// The rules about what to call and how to read the answer live in model.js, where they are
// tested. This module only makes the calls (contracts/coder-cli.md, contracts/herdr-surface.md).
import { exec, hc, home, run, window } from "herdr";
import {
  classifyProblem,
  lastLine,
  listArgs,
  whoamiArgs,
  normalizeWorkspaces,
  parseWhoami,
  openArgs,
  startArgs,
  stopArgs,
  extendArgs,
  vscodeArgs,
  updateArgs,
  pickForwardSpace,
  freshId,
  forwardRunArgs,
  forwardTabName,
} from "./model.js";

/**
 * Runs `coder <argv>` on this computer, under the person's own sign-in.
 *
 * It passes `argv` as given and never adds to it, and it never passes `on`, so a command can
 * never run on a remote machine, whatever space is in view (constitution II).
 *
 * It never throws. It resolves `{ ok, code, stdout, stderr, problem }`, where `problem` is
 * `classifyProblem` of how the command ended, or null when it exited 0. When `exec` itself
 * rejects (the program cannot start, or it was stopped at its 30 s limit), `code` is null,
 * `rejected` is true, and `stderr` holds the rejection's message, so that `lastLine(stderr)`
 * is the reason in every case.
 */
export async function runCoder(argv) {
  let result;
  try {
    result = await exec("coder", argv);
  } catch (error) {
    const rejectMessage = String(error?.message ?? error);
    return {
      ok: false,
      rejected: true,
      code: null,
      stdout: "",
      stderr: rejectMessage,
      problem: classifyProblem({ rejected: true, rejectMessage }),
    };
  }
  const { code, stdout, stderr } = result;
  const problem = classifyProblem({ rejected: false, code, stderr });
  return { ok: problem === null, code, stdout, stderr, problem };
}

// A failed command, as the panel reads it: which kind of problem, and the reason in one line.
const failure = (result) => ({ ok: false, problem: result.problem, message: lastLine(result.stderr) });

/**
 * The person's workspaces: `{ ok: true, workspaces }`, or `{ ok: false, problem, message }`.
 * `now` is what time it is, for reading deadlines (the real clock unless a test says otherwise).
 */
export async function listWorkspaces(now = new Date()) {
  const result = await runCoder(listArgs());
  if (!result.ok) return failure(result);
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch (_error) {
    json = null;
  }
  // An answer that is not a list must not read as "no workspaces".
  if (!Array.isArray(json)) {
    return { ok: false, problem: "other", message: "Coder's answer was not a list of workspaces." };
  }
  return { ok: true, workspaces: normalizeWorkspaces(json, now) };
}

/** Where the person is signed in: `{ ok: true, deployment }`, or `{ ok: false, problem, message }`. */
export async function whoami() {
  const result = await runCoder(whoamiArgs());
  if (!result.ok) return failure(result);
  let deployment = null;
  try {
    deployment = parseWhoami(JSON.parse(result.stdout));
  } catch (_error) {
    // handled below
  }
  if (!deployment) return { ok: false, problem: "other", message: "Coder did not say who is signed in." };
  return { ok: true, deployment };
}

/**
 * Opens a web link in the default browser, on this computer.
 * Resolves `{ ok: true }`, or `{ ok: false, message }` with the reason.
 */
export async function openUrl(url) {
  const open = openArgs(window().platform, url);
  if (!open) return { ok: false, message: "That isn't a web link." };
  try {
    const result = await exec(open.cmd, open.args);
    if (result.code === 0) return { ok: true };
    return { ok: false, message: lastLine(result.stderr) || `${open.cmd} exited ${result.code}` };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) };
  }
}

// ---- Acting on a workspace

// Runs a command that changes a workspace, and says how it ended: `{ ok: true }`, `{ pending: true }`
// when exec stopped waiting at its 30 s limit (the command may still be working: the workspace's own
// build will say, FR-017), or `{ error }` with the reason. Never throws.
async function perform(argv) {
  const result = await runCoder(argv);
  if (result.ok) return { ok: true };
  if (result.problem === "timeout") return { pending: true };
  return { error: lastLine(result.stderr) || "The command failed without saying why." };
}

/** Starts a workspace without waiting for the build. */
export const start = (ref) => perform(startArgs(ref));

/** Stops a workspace; the panel has already asked the person. */
export const stop = (ref) => perform(stopArgs(ref));

// For a command whose effect nothing later confirms (no build follows): one that outlasts exec's
// limit is an error, in words that do not claim it failed, not a wait for something that never comes.
async function performOnce(argv, whenTooLong) {
  const outcome = await perform(argv);
  return outcome.pending ? { error: whenTooLong } : outcome;
}

/**
 * Moves a workspace's stop time to `minutes` from now (`extendPlan` works the number out).
 */
export const extend = (ref, minutes) =>
  performOnce(extendArgs(ref, minutes), "Coder took longer than 30 s to answer, so the stop time may not have moved.");

/** Opens VS Code connected to a running workspace. */
export const openVscode = (ref) => performOnce(vscodeArgs(ref), "Coder took longer than 30 s to open VS Code.");

/**
 * Moves a workspace to its template's new version. It waits for the stop and the start, so a
 * command that outlasts exec's limit is pending, as for Stop: the builds will say.
 */
export const update = (ref) => perform(updateArgs(ref));

// ---- Port forwards (research.md R2, step zero S2)

const reasonOf = (error) => String(error?.message ?? error);

/**
 * Starts a forward as a background terminal on this computer, adopted as a tab of a local space.
 * `spaces` is what `spaces()` lists; `random` makes the fresh ids. Resolves
 * `{ ok: true, address, spaceId, tabId, newSpace, tabName }` or `{ error }`; never throws.
 *
 * It does not rename anything: the app has not made the tab yet when `hc run` returns, and a
 * rename sent then does nothing (S2). The caller renames the tab, and the space when `newSpace`,
 * once `spaces()` lists them (`renameForwardTab`, `renameSpace`).
 */
export async function startForward({ ref, name, local, remote, spaces, random = Math.random }) {
  const picked = pickForwardSpace(spaces);
  const newSpace = picked.id === null;
  const spaceId = picked.id ?? freshId("sp", random);
  const tabId = freshId("tb", random);
  let result;
  try {
    result = await hc(forwardRunArgs({ spaceId, tabId, ref, local, remote, home: home() }));
  } catch (error) {
    return { error: reasonOf(error) };
  }
  if (result.code !== 0) return { error: lastLine(result.stderr) || lastLine(result.stdout) || "herdr-core could not start the forward." };
  let address = null;
  try {
    address = JSON.parse(result.stdout)?.address;
  } catch (_error) {
    address = null;
  }
  if (typeof address !== "string" || !address) return { error: "herdr-core did not say where the forward started." };
  return { ok: true, address, spaceId, tabId, newSpace, tabName: forwardTabName(name, local) };
}

/** Why a forward that finished at once stopped: the last line it said. Never throws. */
export async function forwardFailure(address) {
  const fallback = "The forward stopped right away.";
  try {
    const result = await hc(["read", address, "--lines", "20"]);
    return lastLine(result.stdout) || fallback;
  } catch (_error) {
    return fallback;
  }
}

/** Removes a finished terminal. Never throws. */
export async function removeTerminal(address) {
  try {
    const result = await hc(["rm", address]);
    return result.code === 0 ? { ok: true } : { error: lastLine(result.stderr) || "herdr-core could not remove it." };
  } catch (error) {
    return { error: reasonOf(error) };
  }
}

/** What `hc get` says of a terminal (it still can once the terminal has finished), or null. Never throws. */
export async function terminalInfo(address) {
  try {
    const result = await hc(["get", address, "--json"]);
    if (result.code !== 0) return null;
    const info = JSON.parse(result.stdout);
    return info && typeof info === "object" ? info : null;
  } catch (_error) {
    return null;
  }
}

// An app command, as `{ ok: true }` or `{ error }`: the app refuses an id it does not know by throwing.
function command(name, args) {
  try {
    run(name, args);
    return { ok: true };
  } catch (error) {
    return { error: reasonOf(error) };
  }
}

/** Names a forward's tab. Only once `spaces()` lists it (S2). */
export const renameForwardTab = (tabId, name) => command("tab.rename", { id: tabId, name });

/** Names the space made for forwards. Only once `spaces()` lists it. */
export const renameSpace = (spaceId, name) => command("space.rename", { id: spaceId, name });

/** Brings a forward's terminal into view (FR-021). */
export const focusForward = (address) => command("pane.focus", { terminal: address });

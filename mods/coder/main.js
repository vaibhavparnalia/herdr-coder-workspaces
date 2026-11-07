// The Coder workspace panel for the Herdr app: one mod, two roles
// (research.md R1; contracts/herdr-surface.md, "Roles").
//
//  - The LAUNCHER is the 1x1 popup that mod.json describes, which the shortcut opens
//    (`mod.open:coder`). It opens the panel's window, or closes it when it is open, and goes away.
//  - The PANEL is that window: everything the person sees.
//
// What to show and what to do is decided in model.js; every call to Coder is in coder.js; the
// elements are in ui.js. This file holds the state, the timer, the keys and the wiring.
import { View, div } from "gpui-kit";
import { v_flex, InputState } from "gpui-base";
import { closeOverlay, notify, openOverlay, props, shared, setShared, nextCommand, spaces, terminals, theme } from "herdr";
import {
  INSTALL_URL,
  accountLine,
  actionNotice,
  actionUrl,
  beginAction,
  confirmText,
  dashboardUrl,
  decideEscape,
  decideRefresh,
  extendPlan,
  findForwards,
  forwardGivenUp,
  forwardRenames,
  forwardState,
  initialSelection,
  moveSelection,
  nextRefreshDelay,
  panelView,
  parsePortInput,
  reconcileActions,
  restoreForwards,
  rowActions,
  rowErrorFor,
  saveForwards,
} from "./model.js";
import {
  extend,
  focusForward,
  forwardFailure,
  listWorkspaces,
  openUrl,
  openVscode,
  removeTerminal,
  renameForwardTab,
  renameSpace,
  start,
  startForward,
  stop,
  terminalInfo,
  update,
  whoami,
} from "./coder.js";
import { header, panelBody } from "./ui.js";

const WINDOW_WIDTH = 440;
// focus() in init alone does not take the keyboard: the element is not drawn yet (step zero, S1).
const FOCUS_RETRY_MS = 250;
// How often a forward that is starting is looked at, and what the space made for forwards is called.
const FORWARD_WATCH_MS = 1000;
const FORWARD_SPACE_NAME = "Coder";
const DEFAULT_PORT = "3000";
// Where a panel that closes leaves the forwards it was still watching, for the next one to watch on.
const KEPT_FORWARDS = "coder.startingForwards";

// The commands that change a workspace and wait for its build: the row shows their word at once.
const BUILD_ACTIONS = { start, stop, update };

const sharedNumber = (key) => Number(shared(key)) || 0;

// What the app lists, or nothing should it fail to: the panel still draws, and the watch looks again.
function listed(read) {
  try {
    const value = read();
    return Array.isArray(value) ? value : [];
  } catch (_error) {
    return null;
  }
}

export default class Coder extends View {
  init(_props, cx) {
    const p = props() ?? {};
    // The popup from mod.json has an overlay id and no role. Every other copy is a panel: the
    // window the launcher opens, one a layout shows, or the one `herdr-app check` renders.
    this.launcher = typeof p.overlay === "string" && p.role !== "panel";
    if (this.launcher) {
      this.launch(p.overlay);
      return;
    }
    this.overlay = typeof p.overlay === "string" ? p.overlay : null;
    this.startPanel(cx);
  }

  // ---- Launcher

  launch(overlay) {
    try {
      const open = shared("coder.window");
      let closed = false;
      if (typeof open === "string" && open) {
        try {
          closeOverlay(open);
          closed = true;
        } catch (_error) {
          // The window it names is gone. A stale id must never leave the shortcut dead: forget it, and open the panel instead.
        }
        setShared("coder.window", null);
      }
      if (!closed) {
        // The panel takes the keyboard only for an open the person asked for (FR-032).
        setShared("coder.focusRequest", sharedNumber("coder.focusRequest") + 1);
        openOverlay({ mod: "coder", props: { role: "panel" }, kind: "window", key: "coder", keep: true, width: WINDOW_WIDTH });
      }
    } finally {
      closeOverlay(overlay); // the 1x1 popup goes away whatever happened
    }
  }

  // ---- Panel: start, refresh, close

  startPanel(cx) {
    this.handle = cx.focus_handle();
    this.outcome = null; // how the latest refresh ended
    this.previous = null; // the last good list
    this.lastGoodAt = null;
    this.deployment = null; // where the person is signed in; kept through problems, so they can name the host
    this.who = null; // how the last `coder whoami` ended, so the header can say why the host is missing
    this.rereadDeployment = false; // after a problem, read it again once Coder answers
    this.note = null; // a dismissible message that has no row to sit under
    this.actions = new Map(); // workspace id -> the action the person started on it, while it is pending
    this.errors = new Map(); // workspace id -> the message shown under its row
    this.prompt = null; // the question open in a row: { kind, ref, text, confirmLabel }, or the port box { kind: "port", ref, input, error }
    this.input = InputState.new({ value: DEFAULT_PORT }); // the port box's text, kept for the life of the panel
    this.input.on("submit", (_event, cx) => this.submitPort(cx));
    this.input.on("change", (_event, cx) => {
      if (this.prompt?.kind === "port" && this.prompt.error) {
        this.prompt.error = null;
        cx.notify();
      }
    });
    this.starting = new Map(); // terminal address -> a forward this panel started and is still watching
    this.forwardTimer = null;
    // Forwards a panel that closed was still watching: watched on here, so a failure is still told (and its tab removed).
    const kept = restoreForwards(shared(KEPT_FORWARDS));
    if (shared(KEPT_FORWARDS) != null) setShared(KEPT_FORWARDS, null); // unset reads as null or undefined
    for (const [address, forward] of kept) this.starting.set(address, forward);
    this.refreshing = false;
    this.refreshAgain = false; // another read was asked for (Refresh, or an action ending) while one ran: read once more when it ends
    this.readPredatesAction = false; // an action ended while this read ran: its list may predate the action, so settle on the next
    this.closing = false;
    this.cancelledAt = null; // when Escape last cancelled a question: see `escape`
    this.timer = null;
    const saved = shared("coder.selected");
    this.selected = typeof saved === "string" ? saved : null;

    if (this.overlay) {
      setShared("coder.window", this.overlay);
      const asked = sharedNumber("coder.focusRequest");
      if (asked > sharedNumber("coder.focusDone")) {
        setShared("coder.focusDone", asked);
        this.takeKeyboard(cx);
      }
    }
    this.listenForCommands(cx);
    this.refresh(cx);
    this.watchForwards(cx);
  }

  takeKeyboard(cx) {
    this.handle.focus();
    cx.timer.after(FOCUS_RETRY_MS, (cx) => {
      this.handle.focus();
      cx.notify();
    });
  }

  view(now) {
    return panelView({
      outcome: this.outcome,
      previous: this.previous,
      deployment: this.deployment,
      now,
      state: { actions: this.actions, errors: this.errors, forwards: this.forwardList(now), refreshing: this.refreshing },
    });
  }

  // Every forward the app is running for the workspaces shown, from the live terminals that carry
  // its label (so also one started before the panel was opened), and how each is doing.
  forwardList(now) {
    const live = listed(terminals) ?? [];
    const refs = new Set((this.previous?.workspaces ?? []).map((ws) => ws.ref));
    const list = [];
    for (const ref of refs) {
      for (const found of findForwards(live, ref)) {
        const state = forwardState(this.starting.get(found.address) ?? {}, live.find((t) => t.address === found.address), now);
        list.push({ ref, local: found.local, remote: found.remote, address: found.address, state });
      }
    }
    return list;
  }

  workspaceByRef(ref) {
    return this.previous?.workspaces.find((ws) => ws.ref === ref) ?? null;
  }

  // One refresh at a time, and the next one scheduled only when this one ends (constitution IV).
  // A Refresh while one runs is shown at once and queues one more for when it ends (FR-010, SC-004).
  refresh(cx, { timer = false } = {}) {
    const what = decideRefresh({ refreshing: this.refreshing, queued: this.refreshAgain, closing: this.closing, timer });
    if (what === "skip") return;
    if (what !== "start") {
      if (what === "queue") this.refreshAgain = true;
      cx.notify();
      return;
    }
    this.refreshing = true;
    if (this.timer && !this.timer.is_done()) this.timer.cancel();
    this.timer = null;
    cx.notify(); // the header shows the refresh under way (FR-009)
    cx.spawn(async (cx) => {
      try {
        // Who is signed in is read until it is known, and again after any problem.
        const needWho = !this.deployment || this.rereadDeployment;
        const [list, who] = await Promise.all([listWorkspaces(), needWho ? whoami() : null]);
        const predatesAction = this.readPredatesAction; // taken now: the next read starts clear
        this.readPredatesAction = false;
        if (who) this.who = who;
        if (who?.ok) {
          this.deployment = who.deployment;
          this.rereadDeployment = false;
        }
        this.outcome = list;
        if (list.ok) {
          this.previous = list;
          this.lastGoodAt = new Date();
          // A read that began before an action ended may not show its result: the read that follows will.
          if (!predatesAction) this.settle();
          this.selected = initialSelection(this.view(new Date()).rows, this.selected);
        } else {
          this.rereadDeployment = true;
        }
      } catch (error) {
        this.outcome = { ok: false, problem: "other", message: String(error?.message ?? error) };
      } finally {
        this.refreshing = false;
      }
      if (this.closing) return;
      // An out-of-date list offers nothing (R17): nor does a question or a port box opened on it.
      if (!this.outcome?.ok) this.closePrompt();
      cx.notify();
      if (this.refreshAgain) {
        // Another read was asked for while that one ran (Refresh, or an action ending): read now, which schedules the next one.
        this.refreshAgain = false;
        this.refresh(cx);
      } else {
        this.schedule(cx);
      }
    });
  }

  schedule(cx) {
    const ok = Boolean(this.outcome?.ok);
    const rows = ok ? this.view(new Date()).rows : [];
    const delay = nextRefreshDelay({ rows, pendingActions: this.actions.size, startingForwards: this.starting.size, failed: !ok });
    if (this.timer && !this.timer.is_done()) this.timer.cancel(); // one refresh waits, never two
    this.timer = cx.timer.after(delay, (cx) => this.refresh(cx, { timer: true }));
  }

  listenForCommands(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "close") this.escape(cx);
        else if (command === "refresh") this.refresh(cx);
        cx.notify();
      }
    });
  }

  // Escape, and the close command it is bound to in keys.json: first the open question, and only then
  // the panel. One press can reach both, so the second delivery of a press that cancelled is ignored.
  escape(cx) {
    const now = new Date();
    const what = decideEscape({ hasPrompt: Boolean(this.prompt), cancelledAt: this.cancelledAt, now });
    if (what === "cancel") {
      this.cancelledAt = now;
      this.cancel(cx);
    } else if (what === "close") {
      this.closePanel();
    }
  }

  closePanel() {
    if (this.overlay) closeOverlay(this.overlay);
  }

  async close(_cx) {
    // The launcher is closed the moment it has done its job; that is not the panel closing.
    if (this.launcher || this.closing) return;
    this.closing = true;
    if (this.timer && !this.timer.is_done()) this.timer.cancel();
    if (this.forwardTimer && !this.forwardTimer.is_done()) this.forwardTimer.cancel();
    if (this.starting.size > 0) {
      // The next panel watches these on, and any that another copy of the panel left and no one has taken yet stay too.
      const others = restoreForwards(shared(KEPT_FORWARDS)).filter(([address]) => !this.starting.has(address));
      setShared(KEPT_FORWARDS, saveForwards(new Map([...others, ...this.starting])));
    }
    if (this.overlay) {
      setShared("coder.window", null);
      // Written only here: writing it on every arrow press would redraw every mod each time.
      setShared("coder.selected", this.selected);
    }
  }

  // ---- Panel: actions

  // The person pressed an action's button or letter on a row. It acts only on what that row offers
  // right now, and never twice: a row with an action pending offers nothing.
  press(id, ref, cx) {
    const ws = this.workspaceByRef(ref);
    const offered = this.offered(ws, id);
    if (!offered) return;
    this.closePrompt(); // a press on another row ends the question open on the first
    this.selected = ref;
    if (id === "forward") {
      this.openPortBox(ref, cx);
      return;
    }
    if (id === "open" || id === "log") {
      // Opening a page changes nothing, so it has no pending state: the browser either opens or the row says why not.
      this.openRowLink(id === "log" ? "build" : "workspace", { ref }, cx);
      return;
    }
    if (offered.confirm) {
      this.prompt = { kind: id, ref, ...confirmText(id, ws.name) };
      cx.notify();
      return;
    }
    this.run(id, ws, cx);
  }

  confirm(cx) {
    const prompt = this.prompt;
    if (!prompt || prompt.kind === "port") return;
    this.prompt = null;
    const ws = this.workspaceByRef(prompt.ref);
    // The workspace may have changed while the question was open, or the list gone out of date.
    if (!this.offered(ws, prompt.kind)) {
      cx.notify();
      return;
    }
    this.run(prompt.kind, ws, cx);
  }

  cancel(cx) {
    this.closePrompt();
    cx.notify();
  }

  // Closes the question or the port box, if one is open; the keys are the panel's again.
  closePrompt() {
    if (!this.prompt) return;
    const wasPort = this.prompt.kind === "port";
    this.prompt = null;
    if (wasPort) this.handle.focus();
  }

  // The action `id` as the row of `ws` offers it right now, or null: nothing while the list is out
  // of date (R17), nothing while the row's own action is pending, nothing the workspace's state rules out.
  offered(ws, id) {
    if (!ws || !this.outcome?.ok || this.actions.has(ws.id)) return null;
    return rowActions(ws, { now: new Date() }).find((action) => action.id === id) ?? null;
  }

  // ---- Panel: port forwards

  // The box opens on 3000 with the number selected, and takes the keyboard: typing goes into it (FR-033).
  openPortBox(ref, cx) {
    this.input.set_value(DEFAULT_PORT);
    this.input.set_selected_range({ start: 0, end: DEFAULT_PORT.length });
    this.prompt = { kind: "port", ref, input: this.input, error: null };
    this.input.focus();
    // Like the panel itself, the box is not drawn yet when it opens: ask again.
    cx.timer.after(FOCUS_RETRY_MS, (cx) => {
      if (this.prompt?.kind === "port") this.input.focus();
      cx.notify();
    });
    cx.notify();
  }

  submitPort(cx) {
    const prompt = this.prompt;
    if (!prompt || prompt.kind !== "port") return;
    const parsed = parsePortInput(this.input.value());
    if (!parsed.ok) {
      prompt.error = parsed.message; // nothing starts
      cx.notify();
      return;
    }
    const ws = this.workspaceByRef(prompt.ref);
    this.closePrompt();
    // The workspace may have stopped while the box was open.
    if (this.offered(ws, "forward")) {
      this.errors.delete(ws.id); // a new forward replaces the old message
      this.startForwardOn(ws, parsed.local, parsed.remote, cx);
    }
    cx.notify();
  }

  startForwardOn(ws, local, remote, cx) {
    cx.spawn(async (cx) => {
      const startedAt = new Date();
      const before = spaces();
      const result = await startForward({ ref: ws.ref, name: ws.name, local, remote, spaces: before });
      if (this.closing) return;
      if (result.error) {
        this.errors.set(ws.id, { text: `Port ${local}: ${result.error}`, tone: "error", link: null });
        notify({ title: `Port ${local} forward failed`, body: result.error, level: "error" });
      } else {
        const spacesBefore = (Array.isArray(before) ? before : []).map((space) => space?.id);
        this.starting.set(result.address, { ...result, id: ws.id, ref: ws.ref, local, remote, startedAt, spacesBefore, tabRenamed: false, spaceRenamed: false });
        this.watchForwards(cx);
      }
      cx.notify();
      this.schedule(cx); // the next look at Coder is soon, while a forward starts
    });
  }

  watchForwards(cx) {
    if (this.forwardTimer && !this.forwardTimer.is_done()) return;
    if (this.starting.size === 0 || this.closing) return;
    this.forwardTimer = cx.timer.after(FORWARD_WATCH_MS, (cx) => {
      this.forwardTimer = null;
      this.checkForwards(cx);
    });
  }

  // Looks at each forward that is starting: names its tab once the app lists it (step zero S2), lets
  // it go when it has lived 10 s, and tells the person if its terminal has finished (FR-021). It
  // redraws only when a chip changes, and it always looks again while a forward is starting, up to
  // a minute after the start should the app not say how its terminals are.
  checkForwards(cx) {
    if (this.closing) return;
    const now = new Date();
    let changed = false;
    try {
      const live = listed(terminals);
      const places = listed(spaces) ?? [];
      for (const [address, forward] of [...this.starting]) {
        if (forward.ending) {
          // Being read (forwardEnded). Should that never end, stop waiting for it after a minute.
          if (forwardGivenUp({ startedAt: forward.ending }, now)) {
            this.starting.delete(address);
            changed = true;
          }
          continue;
        }
        const due = forwardRenames(forward, places);
        if (due.space) {
          renameSpace(due.space, FORWARD_SPACE_NAME);
          forward.spaceRenamed = true;
        }
        if (due.tab) {
          renameForwardTab(due.tab, forward.tabName);
          forward.tabRenamed = true;
        }
        const terminal = live?.find((t) => t.address === address);
        if (live && !terminal) {
          // A finished terminal is not in the live list: read what happened to it.
          forward.ending = now;
          this.forwardEnded(address, forward, cx);
        } else if (terminal && forwardState(forward, terminal, now) !== "starting") {
          this.starting.delete(address); // alive 10 s: it is running, and the labels find it from now on
          changed = true;
        } else if (forwardGivenUp(forward, now)) {
          this.starting.delete(address); // the app never said: stop asking
          changed = true;
        }
      }
    } finally {
      this.watchForwards(cx);
      if (changed) cx.notify();
    }
  }

  // A forward's terminal has finished: if it failed to start, say why under its row, and remove its
  // tab. It stays in `starting` until this is done, so a panel that closes meanwhile keeps it.
  forwardEnded(address, forward, cx) {
    cx.spawn(async (cx) => {
      const info = await terminalInfo(address);
      if (this.closing) return;
      if (forwardState(forward, info, new Date()) === "failed") {
        const reason = await forwardFailure(address);
        if (this.closing) return;
        this.errors.set(forward.id, { text: `Port ${forward.local}: ${reason}`, tone: "error", link: null });
        notify({ title: `Port ${forward.local} forward failed`, body: reason, level: "error" });
        await removeTerminal(address);
      }
      // Otherwise it was closed by hand, or ended long after the start: nothing to say.
      this.starting.delete(address);
      cx.notify();
    });
  }

  // Selecting a forward's chip brings its tab into view.
  openForward(forward, cx) {
    const result = focusForward(forward.address);
    if (result.error) {
      const ws = this.previous?.workspaces.find((w) => w.ref === forward.ref);
      if (ws) this.errors.set(ws.id, { text: `Couldn't open the forward's tab: ${result.error}`, tone: "error", link: null });
      cx.notify();
    }
  }

  run(kind, ws, cx) {
    const now = new Date();
    let action = beginAction(kind, ws, now);
    let call;
    if (kind === "extend") {
      // The amount comes from the stop time as the list shows it now (model.js, extendPlan).
      const plan = extendPlan(ws, now);
      if (!plan.offered) return;
      action = { ...action, clamped: plan.clamped };
      call = () => extend(ws.ref, plan.minutes);
    } else if (kind === "vscode") {
      call = () => openVscode(ws.ref);
    } else {
      call = () => BUILD_ACTIONS[kind](ws.ref);
    }
    this.errors.delete(ws.id); // a new action replaces the old message
    this.actions.set(ws.id, action);
    cx.notify(); // the row says what is happening within a second (FR-013, SC-004)
    cx.spawn(async (cx) => {
      const outcome = await call();
      if (this.closing) return;
      if (this.actions.get(ws.id) === action) this.actions.set(ws.id, { ...action, exec: outcome });
      // A command that failed ends its action now. A +1h that worked waits for the list that shows
      // the new stop time, so the note under the row can say it.
      if (!(kind === "extend" && outcome.ok)) this.settle();
      cx.notify();
      if (kind === "vscode") return; // nothing about the workspace changed: no need to ask Coder
      // Ask Coder how the workspace is doing: now, or as soon as the read under way ends. That read
      // may have begun before the action ended, so it is not the one to settle it on.
      if (this.refreshing) this.readPredatesAction = true;
      this.refresh(cx);
    });
  }

  // Ends every pending action the latest list can settle, and tells the person once (FR-015, FR-016).
  settle() {
    if (!this.previous) return;
    const now = new Date();
    const { actions, events } = reconcileActions({ actions: this.actions, workspaces: this.previous.workspaces, now });
    this.actions = new Map(Object.entries(actions));
    for (const event of events) {
      const notice = actionNotice(event);
      if (notice) notify(notice);
      const error = rowErrorFor(event, this.previous.workspaces.find((ws) => ws.id === event.id), now);
      if (error) this.errors.set(event.id, error);
      else if (event.state === "done") this.errors.delete(event.id);
    }
    // Messages and questions about workspaces that are gone, or no longer offer the action, go too.
    const listed = new Set(this.previous.workspaces.map((ws) => ws.id));
    for (const id of [...this.errors.keys()]) if (!listed.has(id)) this.errors.delete(id);
    if (this.prompt) {
      const ws = this.workspaceByRef(this.prompt.ref);
      const wanted = this.prompt.kind === "port" ? "forward" : this.prompt.kind;
      if (!ws || !rowActions(ws, { now: new Date() }).some((action) => action.id === wanted)) this.closePrompt();
    }
  }

  // ---- Panel: keys and clicks

  // Only the exact chord counts, so `s` never matches `cmd-s` or `shift-s` (research R8).
  // While a question is open, the keys belong to it.
  onKey(event, cx) {
    const key = event.keystroke;
    if (key === "escape") {
      this.escape(cx);
    } else if (this.prompt?.kind === "port") {
      return; // typing and Enter belong to the box; only Esc is the panel's
    } else if (this.prompt) {
      if (key === "enter") this.confirm(cx);
      else if (key === "r") this.refresh(cx);
      else return;
    } else if (key === "up" || key === "down") {
      this.selected = moveSelection(this.view(new Date()).rows, this.selected, key === "up" ? -1 : 1);
      cx.notify();
    } else if (key === "r") {
      this.refresh(cx);
    } else {
      // A letter runs that action on the selected row, if the row offers it; otherwise nothing happens.
      const row = this.view(new Date()).rows.find((r) => r.ref === this.selected);
      const action = row?.actions.find((a) => a.letter === key);
      if (!action) return; // anything else, including every chord with a modifier, passes through untouched
      this.press(action.id, row.ref, cx);
    }
    cx.stop_propagation();
  }

  select(ref, cx) {
    if (this.prompt && this.prompt.ref !== ref) this.closePrompt(); // a question is about its own row
    this.selected = ref;
    this.handle.focus();
    cx.notify();
  }

  // Opens a page in the browser, and says why if it cannot (a failure leaves a trace, constitution III).
  open(url, fail, cx) {
    if (!url) return;
    cx.spawn(async (cx) => {
      const result = await openUrl(url);
      if (!result.ok) {
        fail(`Couldn't open the link: ${result.message}`);
        cx.notify();
      }
    });
  }

  // The links in the whole-panel states: where to get the CLI, and the dashboard.
  openPanelLink(which, cx) {
    const url = which === "install" ? INSTALL_URL : dashboardUrl(this.deployment);
    this.open(url, (text) => (this.note = text), cx);
  }

  // The page behind a row: its workspace's, or its last build's (the Open and Build log actions, and the link in a message).
  openRowLink(page, row, cx) {
    const ws = this.workspaceByRef(row.ref);
    if (!ws) return;
    const url = actionUrl(this.deployment, ws, page === "build" ? "log" : "open");
    const fail = (text) => this.errors.set(ws.id, { text, tone: "error", link: null });
    if (!url) {
      fail("Couldn't open the page: Coder's address isn't known yet.");
      cx.notify();
      return;
    }
    this.open(url, fail, cx);
  }

  // ---- Panel: drawing

  render(_cx) {
    if (this.launcher) return div();
    const t = theme();
    const view = this.view(new Date());
    return v_flex()
      .id("coder")
      .track_focus(this.handle)
      .on_key_down((event, cx) => this.onKey(event, cx))
      .w_full()
      .rounded(10)
      .overflow_hidden()
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(13)
      .border_1()
      .border_color(this.handle.is_focused() ? t.accent : t.border)
      .child(
        header({
          account: accountLine({ deployment: this.deployment, who: this.who, listOk: Boolean(this.outcome?.ok) }),
          lastGoodAt: this.lastGoodAt,
          stale: view.stale,
          refreshing: view.refreshing,
          onRefresh: (cx) => this.refresh(cx),
        }),
      )
      .child(
        panelBody({
          view,
          deployment: this.deployment,
          selected: this.selected,
          note: this.note,
          prompt: this.prompt,
          onSelect: (ref, cx) => this.select(ref, cx),
          onAction: (id, ref, cx) => this.press(id, ref, cx),
          onConfirm: (cx) => this.confirm(cx),
          onCancel: (cx) => this.cancel(cx),
          onSubmitPort: (cx) => this.submitPort(cx),
          onOpenForward: (forward, cx) => this.openForward(forward, cx),
          onDismissError: (row, cx) => {
            this.errors.delete(row.id);
            cx.notify();
          },
          onOpenLink: (page, row, cx) => this.openRowLink(page, row, cx),
          onRefresh: (cx) => this.refresh(cx),
          onOpen: (which, cx) => this.openPanelLink(which, cx),
          onDismissNote: (cx) => {
            this.note = null;
            cx.notify();
          },
        }),
      );
  }
}

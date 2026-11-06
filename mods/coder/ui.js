// The panel's elements (contracts/ui.md): builders that turn what model.js decided into
// something drawn. They decide nothing themselves. Colors come only from `theme()`, so the
// panel follows light and dark; icons are this mod's own SVGs, tinted with the text color.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Input } from "gpui-base";
import { theme } from "herdr";
import { updatedLabel } from "./model.js";

const icon = (name) => `mods/coder/icons/${name}.svg`;

/** The in-progress spinner: the app animates it natively, so nothing redraws on a timer. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** The list stops growing here and scrolls: about 8 rows. */
export const LIST_MAX_HEIGHT = 672;

// A window drags by any press the mod does not stop, so every control stops its own.
const still = (element) => element.on_mouse_down("left", (_event, cx) => cx.stop_propagation());

/** A small bordered button. `label` is what it says, for example "R Retry". `onClick(cx)` runs when it is pressed. */
export function button(id, label, onClick, { primary = false } = {}) {
  const t = theme();
  return still(
    h_flex()
      .id(id)
      .h(26)
      .px(10)
      .items_center()
      .flex_none()
      .rounded(6)
      .border_1()
      .border_color(primary ? t.solid : t.input)
      .bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground)
      .text_size(12)
      .cursor_pointer()
      .hover((s) => s.opacity(0.88))
      .on_click((_event, cx) => onClick(cx))
      .child(label),
  );
}

/** Text that opens something: "Install ↗". */
export function link(id, label, onClick) {
  const t = theme();
  return still(
    div()
      .id(id)
      .flex_none()
      .text_color(t.accent)
      .text_size(12)
      .cursor_pointer()
      .hover((s) => s.opacity(0.75))
      .on_click((_event, cx) => onClick(cx))
      .child(label),
  );
}

// ---- Header

/**
 * The top of the panel (FR-009). First line: the glyph, the title, when the list was last
 * refreshed, whether that is out of date, the Refresh control and an Esc hint. Second line:
 * `account` from the model (`accountLine`), the deployment's host and the signed-in user, which
 * are too long to share a line with those, or why they are not known.
 */
export function header({ account, lastGoodAt, stale, refreshing = false, onRefresh }) {
  const t = theme();
  const stamp = updatedLabel(lastGoodAt);
  const refresh = still(
    h_flex()
      .id("refresh")
      .items_center()
      .gap(4)
      .h(24)
      .px(8)
      .flex_none()
      .rounded(6)
      .border_1()
      .border_color(t.input)
      .text_color(t.muted)
      .text_size(11.5)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_event, cx) => onRefresh(cx))
      // While a refresh runs its icon is the native spinner: no timer redraws it.
      .child(refreshing ? div().id("refresh-spinner").w(12).flex_none().frames(SPINNER_FRAMES, 90) : svg(icon("refresh")).size(12).flex_none())
      .child("R"),
  );
  return v_flex()
    .id("header")
    .px(14)
    .py(8)
    .gap(3)
    .flex_none()
    .border_b_1()
    .border_color(t.border)
    .child(
      h_flex()
        .items_center()
        .gap(8)
        .child(svg(icon("coder")).size(16).flex_none().text_color(t.accent))
        .child(div().flex_1().font_semibold().text_color(t.foreground).child("Coder"))
        .child(
          h_flex()
            .items_center()
            .gap(4)
            .flex_none()
            .text_size(11)
            .child(div().text_color(t.dim).child(stamp))
            .when(stale, (el) => el.child(div().text_color(t.blocked).child("· out of date"))),
        )
        .child(refresh)
        .child(div().flex_none().text_size(11).text_color(t.dim).child("Esc")),
    )
    .when(account && !account.problem, (el) =>
      el.child(
        h_flex()
          .items_center()
          .gap(6)
          .pl(24)
          .min_w_0()
          .text_size(11.5)
          .text_color(t.muted)
          .child(div().min_w_0().truncate().child(account.host))
          .child(div().flex_none().text_color(t.dim).child("·"))
          .child(div().flex_none().max_w(150).truncate().child(account.user)),
      ),
    )
    .when(account?.problem, (el) => el.child(div().pl(24).min_w_0().truncate().text_size(11.5).text_color(t.blocked).child(account.problem)));
}

// ---- Rows

function indicator(row, t) {
  const base = div().w(14).flex_none().text_size(13).text_color(t[row.indicator.color]);
  switch (row.indicator.shape) {
    case "spinner":
      return base.frames(SPINNER_FRAMES, 90);
    case "dot":
      return base.child("●");
    case "cross":
      return base.child("✕");
    default:
      return base.child("○");
  }
}

// What each action's button says. Its letter, from model.js, is shown first: the same key runs it.
const ACTION_LABELS = {
  start: "Start",
  stop: "Stop",
  vscode: "VS Code",
  extend: "+1h",
  forward: "Port…",
  update: "Update",
  open: "↗",
  log: "Log ↗",
};

/** "S Start": the key, then what it does. */
function keycap(letter, name) {
  const t = theme();
  return h_flex()
    .items_center()
    .gap(5)
    .child(div().text_size(11).text_color(t.dim).child(letter.toUpperCase()))
    .child(div().child(name));
}

/**
 * One button per action the row offers, each showing its letter. A click does exactly what the
 * letter does (FR-034): `onAction(id, ref, cx)`.
 */
export function actionButtons(row, onAction) {
  return h_flex()
    .items_center()
    .flex_wrap()
    .gap(6)
    .pl(22)
    .children(
      row.actions.map((action) =>
        button(`${row.id}-${action.id}`, keycap(action.letter, ACTION_LABELS[action.id] ?? action.id), (cx) => onAction(action.id, row.ref, cx)),
      ),
    );
}

/**
 * A question asked in the row, in place of its buttons, before something that ends or interrupts
 * work (FR-014): Enter confirms, Esc cancels. `text` and `confirmLabel` come from the model.
 */
export function confirmPrompt({ text, confirmLabel, onConfirm, onCancel }) {
  const t = theme();
  return v_flex()
    .gap(8)
    .pl(22)
    .child(div().text_color(t.foreground).child(text))
    .child(
      h_flex()
        .items_center()
        .gap(8)
        .child(button("confirm", keycap("Enter", confirmLabel), onConfirm, { primary: true }))
        .child(button("cancel", keycap("Esc", "Cancel"), onCancel)),
    );
}

/**
 * The port box (FR-019), in place of the row's buttons: a field over `input` (an `InputState` the
 * view keeps), with the reason in `blocked` when what was typed cannot be used. Typing goes to the
 * field; Enter (the field's own submit, or the button) forwards, Esc cancels.
 */
export function portPrompt({ input, error, onSubmit, onCancel }) {
  const t = theme();
  return v_flex()
    .gap(8)
    .pl(22)
    .child(div().text_color(t.foreground).child("Forward port"))
    .child(
      still(
        div().child(
          Input.new(input).h(32).px(10).rounded(8).border_1().border_color(error ? t.blocked : t.input).bg(t.background).text_size(13).text_color(t.foreground),
        ),
      ),
    )
    .when(error, (el) => el.child(div().text_size(12).text_color(t.blocked).child(error)))
    .child(
      h_flex()
        .items_center()
        .gap(8)
        .child(button("forward-go", keycap("Enter", "Forward"), onSubmit, { primary: true }))
        .child(button("forward-cancel", keycap("Esc", "Cancel"), onCancel)),
    );
}

/**
 * One clickable `⇄ <port>` for each of a row's forwards (FR-021), to go on its second line. One
 * that is still starting is drawn muted. `onOpen(forward, cx)` brings its tab into view.
 */
export function forwardChips(row, onOpen) {
  const t = theme();
  return row.forwards.map((forward) =>
    still(
      div()
        .id(`forward-${forward.address}`)
        .flex_none()
        .px(5)
        .rounded(4)
        .text_color(forward.starting ? t.dim : t.accent)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_event, cx) => onOpen(forward, cx))
        .child(`⇄ ${forward.local}`),
    ),
  );
}

/**
 * A message under a row that stays until it is dismissed: why an action failed, or that nothing
 * has changed yet. `error` is `{ text, tone, link }` from the model; `onOpen(page, cx)` follows a link.
 */
export function rowMessage(error, { onDismiss, onOpen }) {
  const t = theme();
  return h_flex()
    .items_center()
    .gap(8)
    .pl(22)
    .text_size(12)
    .child(
      h_flex()
        .items_center()
        .gap(6)
        .flex_1()
        .min_w_0()
        .child(div().min_w_0().text_color(error.tone === "error" ? t.blocked : t.muted).child(error.text))
        .when(error.link, (el) => el.child(link("message-link", error.link.label, (cx) => onOpen(error.link.page, cx)))),
    )
    .child(
      still(
        div().id("dismiss").flex_none().px(4).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_event, cx) => onDismiss(cx))
          .child("×"),
      ),
    );
}

/**
 * One workspace: its state and detail on the first line, its template and tags on the second,
 * then either a question (`prompt`) or its buttons, and the last message about it. `selected`
 * marks the row the keyboard acts on; pressing the row selects it.
 */
export function rowView(row, { selected, onSelect, prompt, onAction, onConfirm, onCancel, onSubmitPort, onOpenForward, onDismissError, onOpenLink }) {
  const t = theme();
  const first = h_flex()
    .items_center()
    .gap(8)
    .child(indicator(row, t))
    .child(
      h_flex()
        .items_center()
        .gap(4)
        .flex_1()
        .min_w_0()
        .child(div().min_w_0().truncate().font_semibold().text_color(t.foreground).child(row.name))
        .when(row.tags.includes("unhealthy"), (el) => el.child(div().flex_none().font_semibold().text_color(t.blocked).child("!"))),
    )
    .child(div().flex_none().text_color(t[row.indicator.color]).child(row.word))
    .child(
      div()
        .min_w_0()
        .max_w(230)
        .truncate()
        .text_color(row.warning ? t.blocked : t.muted)
        .child(row.detail),
    );
  const second = h_flex()
    .items_center()
    .gap(6)
    .pl(22)
    .text_size(11.5)
    .text_color(t.dim)
    .child(div().min_w_0().truncate().child(row.template))
    .when(row.tags.includes("outdated"), (el) => el.child(div().flex_none().text_color(t.accent).child("· outdated")))
    .children(forwardChips(row, onOpenForward));
  return still(
    v_flex()
      .id(`row-${row.id}`)
      .px(14)
      .py(10)
      .gap(6)
      .flex_none()
      .border_b_1()
      .border_color(t.border)
      .when(selected, (el) => el.bg(t.selected))
      .hover((s) => s.bg(selected ? t.selected : t.hover))
      .cursor_pointer()
      .on_click((_event, cx) => onSelect(row.ref, cx))
      .child(v_flex().gap(4).child(first).child(second))
      .when(prompt && prompt.kind === "port", (el) => el.child(portPrompt({ input: prompt.input, error: prompt.error, onSubmit: onSubmitPort, onCancel })))
      .when(prompt && prompt.kind !== "port", (el) => el.child(confirmPrompt({ ...prompt, onConfirm, onCancel })))
      .when(!prompt && row.actions.length > 0, (el) => el.child(actionButtons(row, onAction)))
      .when(row.error, (el) => el.child(rowMessage(row.error, { onDismiss: (cx) => onDismissError(row, cx), onOpen: (page, cx) => onOpenLink(page, row, cx) }))),
  );
}

// ---- Whole-panel states

const notice = (...children) => v_flex().px(14).py(12).gap(6).flex_none().children(children);

/** The line shown before the first refresh ends. */
function loading() {
  const t = theme();
  return h_flex()
    .items_center()
    .gap(8)
    .px(14)
    .py(14)
    .text_color(t.muted)
    .child(div().w(14).flex_none().text_color(t.working).frames(SPINNER_FRAMES, 90))
    .child("Loading workspaces…");
}

/** What went wrong, in plain words, with the next step and a way to try again. */
function problemNotice(problem, { onRefresh, onOpen }) {
  const t = theme();
  return notice(
    div().font_semibold().text_color(t.blocked).child(problem.message),
    ...(problem.detail ? [div().text_size(12).text_color(t.muted).child(problem.detail)] : []),
    div().text_size(12).text_color(t.muted).child(problem.hint),
    h_flex()
      .items_center()
      .gap(8)
      .pt(2)
      .child(button("retry", "R Retry", onRefresh))
      .when(problem.kind === "noCli", (el) => el.child(link("install", "Install ↗", (cx) => onOpen("install", cx)))),
  ).border_b_1().border_color(t.border);
}

function emptyNotice({ deployment, onOpen }) {
  const t = theme();
  return notice(
    div().text_color(t.muted).child("No workspaces yet."),
    ...(deployment ? [h_flex().child(link("dashboard", "Open the dashboard ↗", (cx) => onOpen("dashboard", cx)))] : []),
  );
}

function list(rows, { selected, dimmed, prompt, ...handlers }) {
  return v_flex()
    .id("list")
    .max_h(LIST_MAX_HEIGHT)
    .overflow_y_scrollbar()
    .when(dimmed, (el) => el.opacity(0.5))
    .children(
      rows.map((row) =>
        rowView(row, { selected: row.ref === selected, prompt: prompt && prompt.ref === row.ref ? prompt : null, ...handlers }),
      ),
    );
}

/** A one-line message the person can dismiss: why a link would not open. */
function noteLine(note, onDismiss) {
  const t = theme();
  return h_flex()
    .items_center()
    .gap(8)
    .px(14)
    .py(8)
    .flex_none()
    .border_b_1()
    .border_color(t.border)
    .text_size(12)
    .text_color(t.blocked)
    .child(div().flex_1().min_w_0().child(note))
    .child(still(div().id("dismiss-note").flex_none().text_color(t.dim).cursor_pointer().on_click((_event, cx) => onDismiss(cx)).child("×")));
}

/**
 * Everything under the header: loading, the list, a problem (above the earlier list when there
 * is one), or the empty state (FR-025). `onOpen(which, cx)` is told "install" or "dashboard".
 * `note`, when set, is a message shown above all of it, with a × that calls `onDismissNote(cx)`.
 */
export function panelBody({ view, deployment, selected, note, prompt, onSelect, onAction, onConfirm, onCancel, onSubmitPort, onOpenForward, onDismissError, onOpenLink, onRefresh, onOpen, onDismissNote }) {
  if (view.phase === "loading") return loading();
  const parts = [];
  if (note) parts.push(noteLine(note, onDismissNote));
  if (view.phase === "problem") parts.push(problemNotice(view.problem, { onRefresh, onOpen }));
  if (view.rows.length > 0) {
    parts.push(list(view.rows, { selected, dimmed: view.stale, prompt, onSelect, onAction, onConfirm, onCancel, onSubmitPort, onOpenForward, onDismissError, onOpenLink }));
  }
  else if (view.phase === "ready") parts.push(emptyNotice({ deployment, onOpen }));
  return v_flex().children(parts);
}

// The panel's elements: builders that turn what model.js and look.js decided into something
// drawn, in the components of Coder's own dashboard (its status dot, badges, outline buttons and
// keycaps). They decide nothing themselves. Colors come only from `theme()`, or are a theme
// color tinted by look.js, so the panel follows light and dark; icons are this mod's own SVGs,
// tinted with the text color.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Input } from "gpui-base";
import { theme } from "herdr";
import { updatedLabel } from "./model.js";
import { ACTION_LOOK, PROMPT_LOOK, TONES, TINT, tint } from "./look.js";

const icon = (name) => `mods/coder/icons/${name}.svg`;

/** One of this mod's icons, `size` px square, in the text color. */
const iconOf = (name, size) => svg(icon(name)).size(size).flex_none();

/** The theme color of one of Coder's status kinds (look.js). */
export const toneColor = (t, tone) => t[TONES[tone]] ?? t.muted;

/** A key, as Coder's keycap shows one: "R", "Enter", "Esc". `onSolid` for one on a solid button. */
export function keycap(text, { onSolid = false } = {}) {
  const t = theme();
  return h_flex()
    .h(16)
    .min_w(16)
    .px(4)
    .flex_none()
    .justify_center()
    .rounded(4)
    .bg(onSolid ? tint(t.solid_foreground, 0.16) : t.selected)
    .text_size(11)
    .font_medium()
    .text_color(onSolid ? t.solid_foreground : t.muted)
    .child(text);
}

/** A small rounded label in a status kind's colors: "Outdated", "Unhealthy", "Out of date". */
export function badge(text, tone) {
  const t = theme();
  const color = toneColor(t, tone);
  return h_flex()
    .h(18)
    .px(6)
    .flex_none()
    .rounded(6)
    .border_1()
    .border_color(tint(color, TINT.badgeBorder))
    .bg(tint(color, TINT.badgeFill))
    .text_size(11)
    .font_medium()
    .text_color(color)
    .child(text);
}

/** The square a row starts with: two characters of its template, Coder's avatar for a template without an icon. */
export function avatar(text) {
  const t = theme();
  return h_flex()
    .w(32)
    .h(32)
    .flex_none()
    .justify_center()
    .rounded(6)
    .border_1()
    .border_color(t.border)
    .bg(t.raised)
    .text_size(12)
    .font_medium()
    .text_color(t.muted)
    .child(text);
}

/** Coder's status dot: a core in the kind's color within a ring of its tint. It pulses while `moving`. */
export function statusDot(tone, moving) {
  const t = theme();
  const color = toneColor(t, tone);
  const dot = h_flex()
    .w(14)
    .h(14)
    .flex_none()
    .justify_center()
    .rounded_full()
    .bg(tint(color, TINT.ring))
    .child(div().w(6).h(6).rounded_full().bg(color));
  return moving ? dot.loop("opacity", { from: 0.35, to: 1, period: 1200 }) : dot;
}

/** The list stops growing here and scrolls: as tall as before, about six rows with buttons. */
export const LIST_MAX_HEIGHT = 672;

// A window drags by any press the mod does not stop, so every control stops its own.
const still = (element) => element.on_mouse_down("left", (_event, cx) => cx.stop_propagation());

/**
 * A button, as Coder's dashboard draws one: `outline` (a border and no fill, filled under the
 * pointer), `primary` (solid, for the confirm that goes ahead) or `destructive` (red, for the
 * confirm that ends work). It holds an icon, a label or both, then the key that does the same,
 * and names itself when pointed at (`tooltip`). While `spinning`, its icon turns natively and has
 * the id `<id>-spinner`. `onClick(cx)` runs when it is pressed.
 */
export function button(id, { variant = "outline", icon: iconName = null, label = null, key = null, tooltip = null, spinning = false } = {}, onClick) {
  const t = theme();
  const solid = variant === "primary";
  const look = {
    outline: (el) => el.border_1().border_color(t.border).text_color(t.foreground).font_medium().hover((s) => s.bg(t.hover)),
    primary: (el) => el.bg(t.solid).text_color(t.solid_foreground).font_semibold().hover((s) => s.opacity(0.88)),
    destructive: (el) =>
      el
        .border_1()
        .border_color(t.blocked)
        .bg(tint(t.blocked, TINT.destructiveFill))
        .text_color(t.foreground)
        .font_semibold()
        .hover((s) => s.bg(tint(t.blocked, 0))),
  }[variant];
  return still(
    look(
      h_flex()
        .id(id)
        .h(28)
        .pl(label ? 10 : 7)
        .pr(key ? 5 : 10)
        .gap(label && key ? 8 : 5)
        .flex_none()
        .rounded(6)
        .text_size(12)
        .cursor_pointer()
        .on_click((_event, cx) => onClick(cx)),
    )
      // An icon-only button has no text of its own: say what it does to a screen reader.
      .accessibility_label(tooltip ?? label ?? key ?? id)
      .when(tooltip, (el) => el.tooltip(tooltip))
      .when(iconName || label, (el) =>
        el.child(
          h_flex()
            .gap(6)
            .when(iconName, (row) => row.child(spinning ? iconOf(iconName, 14).id(`${id}-spinner`).spin(900) : iconOf(iconName, 14)))
            .when(label, (row) => row.child(label)),
        ),
      )
      .when(key, (el) => el.child(keycap(key, { onSolid: solid }))),
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
 * The top of the panel (FR-009), as Coder's top bar: the mod's mark in a tile; "Coder" over
 * `account` from the model (`accountLine`: the deployment's host and the signed-in user, or why
 * they are not known); then when the list was last refreshed, an "Out of date" badge while the
 * latest refresh failed, the Refresh button with its key (its icon turns while a refresh runs),
 * and the Esc key.
 */
export function header({ account, lastGoodAt, stale, refreshing = false, onRefresh }) {
  const t = theme();
  const tile = h_flex()
    .w(30)
    .h(30)
    .flex_none()
    .justify_center()
    .rounded(7)
    .border_1()
    .border_color(t.border)
    .bg(t.raised)
    .child(iconOf("coder", 16).text_color(t.foreground));
  // The account line runs under the whole top line, so a long host has the width it needs.
  const top = h_flex()
    .items_center()
    .gap(8)
    .child(div().flex_1().min_w_0().truncate().text_size(14).font_semibold().text_color(t.foreground).child("Coder"))
    .child(div().flex_none().text_size(12).text_color(t.muted).child(updatedLabel(lastGoodAt)))
    .when(stale, (el) => el.child(badge("Out of date", "failed")))
    .child(button("refresh", { icon: "refresh", key: "R", tooltip: "Refresh", spinning: refreshing }, onRefresh))
    .child(keycap("Esc"));
  const lines = v_flex()
    .flex_1()
    .min_w_0()
    .gap(2)
    .child(top)
    .when(account && !account.problem, (el) =>
      el.child(
        h_flex()
          .gap(6)
          .min_w_0()
          .text_size(12)
          .font_medium()
          .text_color(t.muted)
          .child(div().min_w_0().truncate().child(account.host))
          .child(div().flex_none().child("·"))
          .child(div().flex_none().max_w(150).truncate().child(account.user)),
      ),
    )
    .when(account?.problem, (el) => el.child(div().min_w_0().truncate().text_size(12).text_color(t.blocked).child(account.problem)));
  return h_flex()
    .id("header")
    .items_center()
    .px(14)
    .py(12)
    .gap(10)
    .flex_none()
    .border_b_1()
    .border_color(t.border)
    .child(tile)
    .child(lines);
}

// ---- Rows

// What sits under a row's name (its buttons, a question, a message) lines up with the name: the
// avatar's 32 px and the 12 px after it.
const INDENT = 44;
// The state's column at the right of every row.
const STATE_WIDTH = 170;

/**
 * One outline button per action the row offers, as the icon buttons of Coder's workspace list:
 * the action's icon (or its short text), then its key. A click does exactly what the key does
 * (FR-034): `onAction(id, ref, cx)`.
 */
export function actionButtons(row, onAction) {
  return h_flex()
    .items_center()
    .flex_wrap()
    .gap(6)
    .pl(INDENT)
    .children(
      row.actions.map((action) => {
        const look = ACTION_LOOK[action.id] ?? { icon: null, text: action.id, tooltip: action.id };
        return button(
          `${row.id}-${action.id}`,
          { icon: look.icon, label: look.text, key: action.letter.toUpperCase(), tooltip: look.tooltip },
          (cx) => onAction(action.id, row.ref, cx),
        );
      }),
    );
}

/**
 * A question asked in the row, in place of its buttons, before something that ends or interrupts
 * work (FR-014): Enter confirms, Esc cancels. `text` and `confirmLabel` come from the model, and
 * the confirm button's kind from look.js: Stop's is destructive, Update's primary.
 */
export function confirmPrompt({ kind, text, confirmLabel, onConfirm, onCancel }) {
  const t = theme();
  return v_flex()
    .gap(8)
    .pl(INDENT)
    .child(div().text_size(13).text_color(t.foreground).child(text))
    .child(
      h_flex()
        .items_center()
        .gap(8)
        .child(button("confirm", { variant: PROMPT_LOOK[kind] ?? "primary", label: confirmLabel, key: "Enter" }, onConfirm))
        .child(button("cancel", { label: "Cancel", key: "Esc" }, onCancel)),
    );
}

/**
 * The port box (FR-019), in place of the row's buttons: a field over `input` (an `InputState` the
 * view keeps), its border and the reason in `blocked` when what was typed cannot be used. Typing
 * goes to the field; Enter (the field's own submit, or the button) forwards, Esc cancels.
 */
export function portPrompt({ input, error, onSubmit, onCancel }) {
  const t = theme();
  return v_flex()
    .gap(8)
    .pl(INDENT)
    .child(div().text_size(13).text_color(t.foreground).child("Forward port"))
    .child(
      still(
        div().child(
          Input.new(input).h(30).px(10).rounded(6).border_1().border_color(error ? t.blocked : t.input).bg(t.background).text_size(13).text_color(t.foreground),
        ),
      ),
    )
    .when(error, (el) => el.child(div().text_size(12).text_color(t.blocked).child(error)))
    .child(
      h_flex()
        .items_center()
        .gap(8)
        .child(button("forward-go", { variant: PROMPT_LOOK.port, label: "Forward", key: "Enter" }, onSubmit))
        .child(button("forward-cancel", { label: "Cancel", key: "Esc" }, onCancel)),
    );
}

/**
 * One port badge for each of a row's forwards (FR-021), on its second line: the port icon and
 * the local port. One that is still starting is drawn at 60%. `onOpen(forward, cx)` brings its
 * tab into view.
 */
export function forwardChips(row, onOpen) {
  const t = theme();
  return row.forwards.map((forward) => {
    const says = `Port ${forward.local}, forwarded to ${forward.remote} in the workspace`;
    return still(
      h_flex()
        .id(`forward-${forward.address}`)
        .h(18)
        .px(6)
        .gap(4)
        .flex_none()
        .rounded(6)
        .border_1()
        .border_color(t.border)
        .bg(t.raised)
        .text_size(11)
        .font_medium()
        .text_color(t.accent)
        .when(forward.starting, (el) => el.opacity(0.6))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_event, cx) => onOpen(forward, cx))
        .accessibility_label(says)
        .tooltip(says)
        .child(iconOf("port", 12))
        .child(String(forward.local)),
    );
  });
}

/**
 * A message in a box, as Coder's alerts: an icon, the text (with a link after it, when there is
 * one) and a control that dismisses it. The box is a tint of the tone: `failed` for a failure,
 * `inactive` for a note.
 */
function alertBox({ tone, text, extra = null, dismissId, onDismiss }) {
  const t = theme();
  const color = toneColor(t, tone);
  const failure = tone === "failed";
  return h_flex()
    .items_start()
    .gap(8)
    .px(10)
    .py(8)
    .rounded(6)
    .border_1()
    .border_color(tint(color, TINT.alertBorder))
    .bg(tint(color, TINT.alertFill))
    .text_size(12)
    .child(iconOf(failure ? "alert" : "info", 14).mt(1).text_color(color))
    .child(
      h_flex()
        .flex_1()
        .min_w_0()
        .flex_wrap()
        .gap(6)
        .child(div().min_w_0().text_color(failure ? t.blocked : t.foreground).child(text))
        .when(extra, (el) => el.child(extra)),
    )
    .child(
      still(
        h_flex()
          .id(dismissId)
          .w(20)
          .h(20)
          .flex_none()
          .justify_center()
          .rounded(4)
          .text_color(t.muted)
          .cursor_pointer()
          .hover((s) => s.text_color(t.foreground).bg(t.hover))
          .on_click((_event, cx) => onDismiss(cx))
          .accessibility_label("Dismiss")
          .child(iconOf("x", 12)),
      ),
    );
}

/**
 * A message under a row that stays until it is dismissed: why an action failed, or that nothing
 * has changed yet. `error` is `{ text, tone, link }` from the model; `onOpen(page, cx)` follows a link.
 */
export function rowMessage(error, { onDismiss, onOpen }) {
  return v_flex()
    .pl(INDENT)
    .child(
      alertBox({
        tone: error.tone === "error" ? "failed" : "inactive",
        text: error.text,
        extra: error.link ? link("message-link", error.link.label, (cx) => onOpen(error.link.page, cx)) : null,
        dismissId: "dismiss",
        onDismiss,
      }),
    );
}

/**
 * One workspace, as a row of Coder's workspace list: its avatar; its name and badges over its
 * template and port badges; and at the right its state (the status dot and word) over the
 * state's detail. Under the name come either a question (`prompt`) or its buttons, and the last
 * message about it. `selected` marks the row the keyboard acts on; pressing the row selects it.
 */
export function rowView(row, { selected, onSelect, prompt, onAction, onConfirm, onCancel, onSubmitPort, onOpenForward, onDismissError, onOpenLink }) {
  const t = theme();
  const name = h_flex()
    .items_center()
    .gap(6)
    .min_w_0()
    .child(div().min_w_0().truncate().text_size(14).font_semibold().text_color(t.foreground).child(row.name))
    .when(row.tags.includes("outdated"), (el) => el.child(badge("Outdated", "pending")))
    .when(row.tags.includes("unhealthy"), (el) => el.child(badge("Unhealthy", "warning")));
  const template = div().min_w_0().truncate().text_size(12).font_medium().text_color(t.muted).child(row.template);
  // The port badges get a line of their own, which wraps: the name column is narrow, and a row may
  // have several forwards.
  const ports = h_flex().flex_wrap().gap(4).pt(2).children(forwardChips(row, onOpenForward));
  // A column of its own, as in Coder's list, so the dots line up from row to row. The detail lines
  // up with the word: the 14 px dot and the 8 px after it.
  const state = v_flex()
    .flex_none()
    .w(STATE_WIDTH)
    .gap(3)
    .child(
      h_flex()
        .gap(8)
        .child(statusDot(row.indicator.tone, row.indicator.moving))
        .child(div().text_size(13).font_medium().text_color(toneColor(t, row.indicator.tone)).child(row.word)),
    )
    .when(row.detail, (el) =>
      el.child(
        div()
          .id(`detail-${row.id}`)
          .pl(22)
          .min_w_0()
          .truncate()
          .text_size(12)
          .font_medium()
          .text_color(row.warning ? toneColor(t, "warning") : t.muted)
          .tooltip(row.detail)
          .child(row.detail),
      ),
    );
  return still(
    v_flex()
      .id(`row-${row.id}`)
      .px(14)
      .py(12)
      .gap(10)
      .flex_none()
      .border_b_1()
      .border_color(t.border)
      .when(selected, (el) => el.bg(t.selected))
      .hover((s) => s.bg(selected ? t.selected : t.hover))
      .cursor_pointer()
      .on_click((_event, cx) => onSelect(row.ref, cx))
      .child(
        h_flex()
          .gap(12)
          .items_start()
          .child(avatar(row.avatar))
          .child(v_flex().flex_1().min_w_0().gap(3).child(name).child(template).when(row.forwards.length > 0, (el) => el.child(ports)))
          .child(state),
      )
      .when(prompt && prompt.kind === "port", (el) => el.child(portPrompt({ input: prompt.input, error: prompt.error, onSubmit: onSubmitPort, onCancel })))
      .when(prompt && prompt.kind !== "port", (el) => el.child(confirmPrompt({ ...prompt, onConfirm, onCancel })))
      .when(!prompt && row.actions.length > 0, (el) => el.child(actionButtons(row, onAction)))
      .when(row.error, (el) => el.child(rowMessage(row.error, { onDismiss: (cx) => onDismissError(row, cx), onOpen: (page, cx) => onOpenLink(page, row, cx) }))),
  );
}

// ---- Whole-panel states

/** A 32 px tile holding an icon: red for a problem, neutral for the mod's mark. */
function noticeTile(iconName, tone) {
  const t = theme();
  const tile = h_flex().w(32).h(32).flex_none().justify_center().rounded(8);
  if (tone === "failed") return tile.bg(tint(t.blocked, TINT.badgeFill)).child(iconOf(iconName, 16).text_color(t.blocked));
  return tile.border_1().border_color(t.border).bg(t.raised).child(iconOf(iconName, 16).text_color(t.muted));
}

/** What shows before the first refresh ends: the ring spinner, which the app turns natively. */
function loading() {
  const t = theme();
  return h_flex()
    .justify_center()
    .gap(8)
    .px(14)
    .py(28)
    .child(iconOf("spinner", 16).text_color(t.muted).spin(900))
    .child(div().text_size(13).text_color(t.muted).child("Loading workspaces…"));
}

/** What went wrong, in plain words, with the next step and a way to try again. */
function problemNotice(problem, { onRefresh, onOpen }) {
  const t = theme();
  return h_flex()
    .items_start()
    .gap(12)
    .px(14)
    .py(14)
    .flex_none()
    .border_b_1()
    .border_color(t.border)
    .child(noticeTile("alert", "failed"))
    .child(
      v_flex()
        .flex_1()
        .min_w_0()
        .gap(4)
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child(problem.message))
        .when(problem.detail, (el) => el.child(div().text_size(12).text_color(t.muted).child(problem.detail)))
        .child(div().text_size(12).text_color(t.muted).child(problem.hint))
        .child(
          h_flex()
            .items_center()
            .gap(10)
            .pt(6)
            .child(button("retry", { icon: "refresh", label: "Retry", key: "R" }, onRefresh))
            .when(problem.kind === "noCli", (el) => el.child(link("install", "Install ↗", (cx) => onOpen("install", cx)))),
        ),
    );
}

/** No workspaces: the mark, the words, and the way to the dashboard. */
function emptyNotice({ deployment, onOpen }) {
  const t = theme();
  return v_flex()
    .items_center()
    .gap(8)
    .px(14)
    .py(24)
    .flex_none()
    .child(noticeTile("coder", "inactive"))
    .child(div().text_size(13).text_color(t.muted).child("No workspaces yet."))
    .when(deployment, (el) => el.child(link("dashboard", "Open the dashboard ↗", (cx) => onOpen("dashboard", cx))));
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

/** A message across the window that the person can dismiss: why a link would not open. */
function noteLine(note, onDismiss) {
  const t = theme();
  return v_flex()
    .px(14)
    .py(10)
    .flex_none()
    .border_b_1()
    .border_color(t.border)
    .child(alertBox({ tone: "failed", text: note, dismissId: "dismiss-note", onDismiss }));
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

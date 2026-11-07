// How the panel looks, as plain data and one pure function: which theme color each of Coder's
// status kinds is, how much a color is tinted where, what each action's button shows, and which
// kind of button confirms each question. Like model.js, this module imports nothing, so every
// rule here is tested with `node --test` (constitution VI). ui.js draws from it.

/**
 * Coder's five status kinds, each as one `theme()` color name. Each was picked as the theme's
 * nearest match to the dashboard's color, and each reads at 4.5:1 or more on the window in the
 * app's dark and light themes. `dim` never appears: it is too faint for words.
 */
export const TONES = Object.freeze({
  success: "ansi2", // green: running
  pending: "ansi6", // sky: starting, queued
  inactive: "muted", // grey: stopping, stopped, canceling, canceled
  warning: "working", // orange: deleting, unhealthy, a stop under 10 minutes
  failed: "blocked", // red: failed, and failures
});

/** How much of a tone's color each part takes, as an alpha over the window's background. */
export const TINT = Object.freeze({
  ring: 0.22, // the ring around a status dot
  badgeFill: 0.12,
  badgeBorder: 0.4,
  alertFill: 0.1,
  alertBorder: 0.35,
  destructiveFill: 0.15, // the button that confirms Stop
});

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const byte = (n) => Math.round(n).toString(16).padStart(2, "0");

/**
 * A theme color made partly transparent: `#rgb` and `#rrggbb` gain an alpha byte, and
 * `#rrggbbaa` keeps its color and has its own alpha scaled. `alpha` is clamped to 0..1, and the
 * result is lower-case. Anything else comes back as it was, so a theme that names a color some
 * other way still draws.
 */
export function tint(color, alpha) {
  if (typeof color !== "string" || !HEX.test(color)) return color;
  const a = Math.min(1, Math.max(0, Number(alpha) || 0));
  let hex = color.slice(1).toLowerCase();
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
  const own = hex.length === 8 ? parseInt(hex.slice(6), 16) : 255;
  return `#${hex.slice(0, 6)}${byte(own * a)}`;
}

/**
 * What each action's button shows besides its key: the name of its icon in `icons/` (or a short
 * text where no icon says it as well), and the name the button shows when pointed at. The
 * actions themselves, their keys and when each is offered are model.js's `rowActions`.
 */
export const ACTION_LOOK = Object.freeze({
  start: { icon: "play", text: null, tooltip: "Start workspace" },
  stop: { icon: "square", text: null, tooltip: "Stop workspace" },
  vscode: { icon: "code", text: null, tooltip: "Open in VS Code" },
  extend: { icon: null, text: "+1h", tooltip: "Add an hour before it stops" },
  forward: { icon: "port", text: null, tooltip: "Forward a port" },
  update: { icon: "rotate", text: null, tooltip: "Update to the template's new version" },
  open: { icon: "external", text: null, tooltip: "Open in the Coder dashboard" },
  log: { icon: "file", text: null, tooltip: "Open the build log" },
});

/** The kind of button that confirms each question a row asks: Stop ends work, so it is destructive. */
export const PROMPT_LOOK = Object.freeze({
  stop: "destructive",
  update: "primary",
  port: "primary",
});

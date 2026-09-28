/**
 * "rule.created" -> "Rule created"; "settings.reorder_threshold_changed" ->
 * "Settings reorder threshold changed". Every action string in this
 * codebase follows the same dot-namespaced, underscore-separated convention
 * (see audit-log.ts's own doc comment) -- this is a generic formatter, not
 * a per-action lookup table, so a new instrumented route needs no change
 * here to render sensibly.
 *
 * Extracted out of settings/activity/page.tsx (unchanged logic, just moved)
 * so /dashboard's live activity feed can reuse the exact same formatting
 * instead of drifting from it with its own copy.
 */
export function describeAction(action: string): string {
  const words = action.replace(/[._]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

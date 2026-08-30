/**
 * Turning a seat into a name to show.
 *
 * The rule this exists to enforce: **a published seat label must mean the same
 * thing to everybody**. Labels travel in the `start` event, so a word that
 * means "the person reading this" is not a name — it is a rendering decision
 * that got written into shared state.
 *
 * It happened: seat labels were seeded from a helper that returned "Vos" for
 * the current user, so the host's seat was published as literally "Vos" and
 * every other player at the table saw somebody called that.
 */

/**
 * Labels that read like a name but mean "whoever is looking". Published ones
 * are treated as absent so the profile name shows instead — that repairs
 * tables created before the bug was fixed, which still carry these on the
 * relay and cannot be edited.
 */
const VIEWER_RELATIVE = new Set(['vos', 'you', 'tú', 'tu', 'yo', 'me', 'myself']);

export function isViewerRelativeLabel(label: string | undefined | null): boolean {
  if (!label) return false;
  return VIEWER_RELATIVE.has(label.trim().toLowerCase());
}

/**
 * The name to show for a seat: its published label when that label is a real
 * name, otherwise the controller's profile name.
 */
export function seatDisplayLabel(label: string | undefined | null, fallback: string): string {
  if (!label || isViewerRelativeLabel(label)) return fallback;
  return label;
}

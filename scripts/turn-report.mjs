// ============================================================================
// scripts/turn-report.mjs — what the chef receives when a musician's turn ends
// ============================================================================
//
// Two different things, never to be confused again (0.100.3, TODO t-a7f8ca):
//   - summarizeResult: a SHORT line for cards and desktop notifications (last
//     paragraph, 280 characters, cut stated). Display only.
//   - fullReport: the musician's WHOLE final report, the one the chef reads (wake
//     prompt, conversation excerpt of the Routage). Before 0.100.3 the chef got
//     the short line: every paragraph but the last was dropped and the last was
//     cut at 280 characters, so the number of tests passed never reached it.
//     Beyond REPORT_MAX the cut is stated, with where the whole text is.
// ============================================================================

export const SUMMARY_MAX = 280;
export const REPORT_MAX = 8000;

/** Short human-facing line: the last paragraph of the result (musicians end
 *  with their conclusion), capped at SUMMARY_MAX on a word boundary. */
export function summarizeResult(ev) {
  const raw = typeof ev?.result === 'string' ? ev.result.trim() : '';
  if (!raw) return '';
  const paras = raw.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  let last = paras.length ? paras[paras.length - 1] : raw;
  // A very short tail (a closing line like "Terminé.") carries no information.
  if (last.length < 40 && paras.length > 1) last = `${paras[paras.length - 2]} ${last}`;
  last = last.replace(/\s+/g, ' ').trim();
  if (last.length <= SUMMARY_MAX) return last;
  const kept = last.slice(0, SUMMARY_MAX - 1).replace(/\s+\S*$/, '');
  return `${kept}… ⚠ [résumé coupé : ${kept.length} caractères sur ${last.length} — compte rendu complet dans le journal du musicien, et dans la conversation s’il a été envoyé au chef]`;
}

/** The whole final report of a turn, layout kept. Cut only beyond `max`, and
 *  then always with an explicit notice naming where the whole text is. */
export function fullReport(ev, { max = REPORT_MAX, where = null } = {}) {
  const raw = typeof ev?.result === 'string' ? ev.result.trim() : '';
  if (!raw || raw.length <= max) return raw;
  const kept = raw.slice(0, max).replace(/\s+\S*$/, '');
  return `${kept} […]\n⚠ [compte rendu tronqué par l’orchestrateur : ${kept.length} caractères sur ${raw.length}` +
    `${where ? ` — texte complet : ${where}` : ' — texte complet dans le journal du musicien'}]`;
}

/** Body of one result in the chef's wake prompt: the full report (indented),
 *  falling back to the short line for items queued before 0.100.3. */
export function wakeItemBody(it) {
  const body = String((typeof it?.report === 'string' && it.report.trim()) ? it.report : (it?.summary || '')).trim();
  return body ? body.split('\n').map(l => `  ${l}`).join('\n') : '';
}

/** Text of a turn-end notification as the chef must read it: the full report
 *  when the event carries one (0.100.3+), the short line otherwise. */
export function notificationReportText(e) {
  if (typeof e?.report === 'string' && e.report.trim()) {
    const head = String(e.text || '').split(/(?<=\.)\s/)[0] || `[${e.source || '?'}]`;
    return `${head}\n\n${e.report.trim()}`;
  }
  return typeof e?.text === 'string' ? e.text : '';
}

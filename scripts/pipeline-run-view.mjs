// One row of GET /api/pipeline-runs, built from a run.json.
// A paused run carries its pause menu (pause-diagnosis.mjs: cause, choices,
// recommendation) so clients that do not parse the pause Markdown (Android
// app 1.0.0) can offer the choices as buttons. Only what the user reads is
// exposed: never an option's internal effect, never the raw evidence.

const str = (v, max) => (typeof v === 'string' && v.trim() ? (max ? v.slice(0, max) : v) : null);

export function pauseView(s) {
  if (s?.status !== 'paused') return null;
  const d = s.diagnosis || {};
  const rec = str(d.recommend?.key);
  const seen = new Set();
  const options = [];
  for (const o of Array.isArray(d.options) ? d.options : []) {
    const key = str(o?.key, 80), does = str(o?.does, 600);
    if (!key || !does || seen.has(key)) continue;
    seen.add(key);
    options.push({ key, does, recommended: key === rec });
  }
  return {
    cause: str(d.cause, 600), kind: str(d.kind), transient: d.transient === true, step: str(d.step), limit: str(d.limit),
    options, recommend: rec && options.some(o => o.key === rec) ? { key: rec, why: str(d.recommend?.why, 600) } : null,
  };
}

export function runView(s) {
  return {
    run: s.run, project: s.project, pipeline: s.pipeline, mode: s.mode, kind: s.kind, status: s.status,
    createdAt: s.createdAt, endedAt: s.endedAt || null, question: s.question || null, backoff: s.backoff || null,
    steps: (s.steps || []).map(x => ({ id: x.id, key: x.key, title: x.title, slot: x.slot, model: x.model, served: x.served,
      source: x.source, status: x.status, why: x.why ? String(x.why).slice(0, 300) : null, durationMs: x.durationMs })),
    pause: pauseView(s),
  };
}

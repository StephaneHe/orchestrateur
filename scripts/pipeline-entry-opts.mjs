// ============================================================================
// scripts/pipeline-entry-opts.mjs — the pipeline choice of an entry (phase 5,
// 0.52.0): validated from a request body, turned into dispatch.mjs flags, or
// into a visible prefix for the chef.
// ============================================================================

const RUN_RE = /^p-\d{8}T\d{6}-[a-z0-9]{4,8}$/;

/** Selector / caller choice; "auto" or absent = classification decides. */
export function pipelineOptsFrom(body) {
  const b = body || {};
  return {
    pipeline:       ['discussion', 'dev'].includes(b.pipeline) ? b.pipeline : undefined,
    pipelineMode:   ['leger', 'complet'].includes(b.pipelineMode) ? b.pipelineMode : undefined,
    pipelineResume: typeof b.pipelineResume === 'string' && RUN_RE.test(b.pipelineResume) ? b.pipelineResume : undefined,
    horsPipeline:   typeof b.horsPipeline === 'string' && b.horsPipeline.trim() ? b.horsPipeline.replace(/\s+/g, ' ').trim().slice(0, 300) : undefined,
  };
}

/** dispatch.mjs flags (argv array, never shell-concatenated). */
export function pipelineArgs(o) {
  const a = [];
  if (o.pipeline) a.push('--pipeline', o.pipeline);
  if (o.pipelineMode) a.push('--mode', o.pipelineMode);
  if (o.pipelineResume) a.push('--pipeline-resume', o.pipelineResume);
  if (o.horsPipeline) a.push('--hors-pipeline', o.horsPipeline);
  return a;
}

/** Towards the chef the choice becomes a visible prefix (« /dev /complet … »)
 *  that the chef passes on (its contract, 0.52.0). An existing prefix wins. */
export function withPipelinePrefix(text, o) {
  if (!o.pipeline && !o.pipelineMode) return text;
  if (/^\s*\/(dev|developpement|développement|code|discussion|question|discuter|leger|léger|complet)\b/i.test(text)) return text;
  const pipe = o.pipeline || 'dev';
  const pre = [`/${pipe}`, o.pipelineMode && pipe === 'dev' ? `/${o.pipelineMode}` : ''].filter(Boolean).join(' ');
  return `${pre} ${text}`;
}

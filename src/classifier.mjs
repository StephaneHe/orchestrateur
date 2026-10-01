// ============================================================================
// src/classifier.mjs — Haiku-based interrupt classifier.
// ============================================================================
//
// Spawns a one-shot Haiku call via the local claude CLI (using array argv,
// shell:false — no shell interpolation, no command-injection surface). The
// CLI's --print --output-format=json emits a single envelope with a `result`
// field containing the assistant's text; the classifier expects that text
// to be a single JSON object.
// ============================================================================

import { spawn } from 'node:child_process';

const HAIKU = 'claude-haiku-4-5-20251001';
const PROMPT_TEMPLATE = `You are a binary classifier helping an AI agent orchestrator decide whether to interrupt an in-flight task.

Current turn (in-flight) summary: {{TURN}}
New user prompt: {{PROMPT}}

Decide: should the in-flight task be INTERRUPTED, QUEUED (kept running), or is it AMBIGUOUS?

Output rules — reply with EXACTLY one JSON object on one line, no other text:
{"verdict": "useless_now" | "still_useful" | "uncertain", "lean": "interrupt" | "queue", "reasoning": "<brief>"}

Verdict semantics:
- useless_now: the new prompt invalidates, cancels, or replaces the in-flight work.
- still_useful: the new prompt is additive, complementary, or "when you are done".
- uncertain: not enough information; respond uncertain and set "lean" to your best guess.

Lean is required even for useless_now / still_useful (set it = the corresponding action: interrupt | queue).

Output ONLY the JSON, no markdown, no preamble.`;

function buildPrompt(turn, prompt) {
  return PROMPT_TEMPLATE
    .replace('{{TURN}}',   turn)
    .replace('{{PROMPT}}', prompt);
}

function runHaiku(prompt, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const argv = [
      '--print',
      '--output-format', 'json',
      '--model', HAIKU,
      '--setting-sources', 'project,local',
      '--strict-mcp-config',
      '--disable-slash-commands',
      prompt,
    ];
    const child = spawn('claude', argv, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('classifier timeout'));
    }, timeoutMs);

    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exit=${code} stderr=${stderr.slice(0, 300)}`));
      resolve(stdout);
    });
  });
}

function extractVerdict(rawCliJson) {
  let envelope;
  try { envelope = JSON.parse(rawCliJson); } catch { envelope = null; }

  let assistantText = null;
  if (envelope && typeof envelope.result === 'string') {
    assistantText = envelope.result;
  } else {
    for (const line of rawCliJson.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'assistant') {
          for (const b of ev.message?.content || []) {
            if (b.type === 'text' && typeof b.text === 'string') assistantText = b.text;
          }
        } else if (typeof ev.result === 'string') {
          assistantText = ev.result;
        }
      } catch {}
    }
  }
  if (!assistantText) return null;

  const stripped = assistantText.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const m = /\{[\s\S]*\}/.exec(stripped);
  if (!m) return null;
  try { return JSON.parse(m[0]); }
  catch { return null; }
}

export async function classify(turnSummary, newPrompt) {
  const prompt = buildPrompt(turnSummary, newPrompt);
  const raw = await runHaiku(prompt);
  const v = extractVerdict(raw);
  if (!v || typeof v.verdict !== 'string') return null;
  return v;
}

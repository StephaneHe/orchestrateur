// ============================================================================
// scripts/changelog-links.mjs — link reference lines of a Keep a Changelog file
// ============================================================================
//
// Every program path that writes a `## [X.Y.Z]` header (Livrer by the program,
// release assembled from a lane's fragments) must also write the `[X.Y.Z]: …`
// line when the project keeps such lines: a project's release test reads them,
// and two deliveries went red without it (2026-11-02 and 2026-11-04). A project
// with no version reference line never gets one. Pure functions on the text.
// ============================================================================

const REF_RE = /^\[(\d+\.\d+\.\d+[^\]]*)\]:[ \t]*(\S.*)$/;
const VERSION_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]*[0-9A-Za-z])?/g;

function semverOrder(a, b) {
  const nums = (v) => String(v).split(/[-+]/)[0].split('.').map(Number);
  const [x, y] = [nums(a), nums(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** Version reference lines, in file order: [{version, url, index}] (index = line number). */
function versionRefs(lines) {
  return lines.flatMap((line, index) => {
    const m = REF_RE.exec(line);
    return m ? [{ version: m[1], url: m[2], index }] : [];
  });
}

export const hasVersionLinks = (text) => versionRefs(String(text).split(/\r?\n/)).length > 0;

/** True when the project keeps reference lines and this version has none. */
export function missingVersionLink(text, version) {
  const refs = versionRefs(String(text).split(/\r?\n/));
  return refs.length > 0 && !refs.some(r => r.version === version);
}

/**
 * The text with the `[version]: …` line added, in the format of the latest
 * reference (`./`, a tag URL, a compare URL) and at the file's own ordering
 * (above the latest when newest first, below it when oldest first). A compare
 * URL shifts both ends; `[Unreleased]: …compare/vPREV...HEAD` follows too.
 * No version reference, or the line already there: the text, unchanged.
 */
export function withVersionLink(text, version) {
  const source = String(text);
  if (!missingVersionLink(source, version)) return source;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const refs = versionRefs(lines);
  const latest = refs.reduce((best, r) => (semverOrder(r.version, best.version) > 0 ? r : best));
  const url = latest.url.replace(VERSION_RE, (v) => (v === latest.version ? version : latest.version));
  const ascending = refs.length > 1 && semverOrder(refs[0].version, refs.at(-1).version) < 0;
  const at = ascending ? refs.at(-1).index + 1 : refs[0].index;
  const added = [...lines.slice(0, at), `[${version}]: ${url}`, ...lines.slice(at)];
  return added
    .map(line => (/^\[Unreleased\]:/i.test(line) ? line.split(latest.version).join(version) : line))
    .join(eol);
}

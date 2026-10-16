// Chat attachment policy (0.108.0), shared by the browser and the server:
// accepted types, size cap and the user-facing refusal text. Like turn-core.js,
// no import/export: it sets globalThis.AttachPolicy so server.js can import it
// and the dashboard can load it with a plain <script>.
(function () {
  const MB = 1024 * 1024;
  const MAX_BYTES = 500 * MB;

  // MIME → stored extension. Order is the order shown in messages.
  const MIME_EXT = [
    ['image/png',          '.png'],
    ['image/jpeg',         '.jpg'],
    ['image/webp',         '.webp'],
    ['image/gif',          '.gif'],
    ['video/mp4',          '.mp4'],
    ['video/webm',         '.webm'],
    ['video/quicktime',    '.mov'],
    ['video/x-matroska',   '.mkv'],
  ];
  const MIME_TO_EXT = new Map(MIME_EXT);

  // Other spellings browsers / OSes give for the same formats.
  const MIME_ALIASES = new Map([
    ['image/jpg',            'image/jpeg'],
    ['video/matroska',       'video/x-matroska'],
    ['video/mkv',            'video/x-matroska'],
    ['application/x-matroska', 'video/x-matroska'],
  ]);

  // Browsers often give no type (or application/octet-stream) for .mkv on
  // Windows, so the extension decides when the type does not.
  const EXT_TO_MIME = new Map([
    ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'], ['gif', 'image/gif'],
    ['mp4', 'video/mp4'], ['webm', 'video/webm'], ['mov', 'video/quicktime'],
    ['mkv', 'video/x-matroska'],
  ]);

  const FORMATS_TEXT = 'images (PNG/JPG/WEBP/GIF) et vidéos (MP4/WEBM/MOV/MKV)';
  const LIMIT_TEXT = `${MAX_BYTES / MB} Mo`;

  function normalizeMime(mime) {
    const m = String(mime || '').split(';')[0].trim().toLowerCase();
    return MIME_ALIASES.get(m) || m;
  }

  function extOf(name) {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  // The canonical MIME for a file {name, type}, or '' when not accepted.
  function mediaTypeOf(file) {
    const t = normalizeMime(file && file.type);
    if (MIME_TO_EXT.has(t)) return t;
    return EXT_TO_MIME.get(extOf(file && file.name)) || '';
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= MB) return `${(n / MB).toFixed(n >= 100 * MB ? 0 : 1).replace('.', ',')} Mo`;
    return `${Math.ceil(n / 1024)} Ko`;
  }

  function tooBigText(name, size) {
    const who = name ? `${name} ` : 'Fichier ';
    const shown = formatSize(size);
    const got = size != null ? `(${shown === LIMIT_TEXT ? `plus de ${shown}` : shown}) ` : '';
    return `${who}${got}trop volumineux : limite ${LIMIT_TEXT} par pièce jointe.`;
  }

  function unsupportedText(names) {
    const list = [].concat(names || []).filter(Boolean).join(', ');
    return `Type non supporté${list ? ` : ${list}` : ''} — accepté : ${FORMATS_TEXT}, ${LIMIT_TEXT} max.`;
  }

  // Client-side check of one File-like {name, type, size}.
  function check(file) {
    const mediaType = mediaTypeOf(file);
    if (!mediaType) return { ok: false, reason: 'type', message: unsupportedText([file && file.name]) };
    if (Number(file.size) > MAX_BYTES) {
      return { ok: false, reason: 'size', mediaType, message: tooBigText(file.name, file.size) };
    }
    return { ok: true, mediaType, isVideo: mediaType.startsWith('video/') };
  }

  globalThis.AttachPolicy = {
    MAX_BYTES, LIMIT_TEXT, FORMATS_TEXT,
    MIME_TO_EXT, EXT_TO_MIME,
    normalizeMime, mediaTypeOf, extOf, formatSize,
    tooBigText, unsupportedText, check,
  };
})();

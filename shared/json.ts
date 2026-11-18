// The one home of the "plain JSON object" guard and the JSON error position (coding standard §4, `HELPER_HOMES`),
// shared by engine and web.

/** A non-null, non-array object (a parsed JSON object). */
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Where JSON parsing stops (1-based line / column; Bun's JSON.parse message carries no position): a minimal scanner.
 *  Engine K14 (`~/.claude.json` line) and web K4-bad (pasted JSON line + column). */
export function jsonErrorAt(text: string): { line: number; col: number } {
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++; };
  const fail = (): never => { throw new SyntaxError(`at ${i}`); };
  const str = () => {
    if (text[i] !== '"') fail();
    for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    if (i >= text.length) fail();
    i++;
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      i++; ws();
      if (text[i] === close) { i++; return; }
      for (;;) {
        if (close === '}') { ws(); str(); ws(); if (text[i] !== ':') fail(); i++; }
        value(); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === close) { i++; return; }
        fail();
      }
    }
    if (c === '"') return str();
    const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) fail();
    i += m![0].length;
  };
  try { value(); ws(); if (i < text.length) fail(); } catch { /* `i` = where it stopped */ }
  const before = text.slice(0, i);
  return { line: before.split('\n').length, col: i - before.lastIndexOf('\n') };
}

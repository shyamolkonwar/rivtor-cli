/**
 * Minimal dotenv parser: comments, `export ` prefix, single/double/backtick quotes,
 * escapes (\n \r \t \" \\) in double quotes, multi-line quoted values, inline comments
 * after unquoted values.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  let i = 0;
  const n = src.length;
  while (i < n) {
    // skip whitespace / blank lines
    while (i < n && (src[i] === " " || src[i] === "\t" || src[i] === "\n")) i++;
    if (i >= n) break;
    if (src[i] === "#") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    let lineEnd = src.indexOf("\n", i);
    if (lineEnd === -1) lineEnd = n;
    const head = src.slice(i, lineEnd);
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*/.exec(head);
    if (!m) {
      i = lineEnd; // malformed line: ignore
      continue;
    }
    const key = m[1];
    i += m[0].length;
    const q = src[i];
    if (q === '"' || q === "'" || q === "`") {
      let j = i + 1;
      let val = "";
      while (j < n && src[j] !== q) {
        if (q === '"' && src[j] === "\\" && j + 1 < n) {
          const c = src[j + 1];
          val += c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c;
          j += 2;
          continue;
        }
        val += src[j];
        j++;
      }
      if (j >= n) {
        // unterminated quote: treat rest of the line literally
        out[key] = src.slice(i, lineEnd).trim();
        i = lineEnd;
        continue;
      }
      out[key] = val;
      i = j + 1;
      const next = src.indexOf("\n", i);
      i = next === -1 ? n : next;
      continue;
    }
    let raw = src.slice(i, lineEnd);
    const hash = raw.search(/\s#/);
    if (hash !== -1) raw = raw.slice(0, hash);
    out[key] = raw.trim();
    i = lineEnd;
  }
  return out;
}

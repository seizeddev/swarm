// SPDX-License-Identifier: GPL-3.0-or-later
// Pure diff-presentation helpers: word-level intra-line diffing and a tiny
// single-line tokenizer for *monochrome* code emphasis (brightness/weight, never
// hue — the app's identity is strictly monochrome). No dependencies; both are
// unit-tested so the DiffEditor can stay a thin renderer.

export type Seg = { text: string; changed: boolean };

// Split into word-ish tokens (runs of whitespace, identifiers, or single
// punctuation) so the diff aligns on meaningful boundaries instead of characters
// — "fooBar" → "fooBaz" highlights the word, not a lone letter.
function wordTokens(s: string): string[] {
  return s.match(/\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) ?? [];
}

function pushSeg(segs: Seg[], text: string, changed: boolean): void {
  const last = segs[segs.length - 1];
  if (last && last.changed === changed) last.text += text;
  else segs.push({ text, changed });
}

// LCS-based word diff between a removed line `a` and the added line `b`. Returns
// the segments for each side, with `changed` marking the spans unique to that
// side. O(n·m) on token counts — fine for single lines.
export function wordDiff(a: string, b: string): { a: Seg[]; b: Seg[] } {
  const ta = wordTokens(a);
  const tb = wordTokens(b);
  const n = ta.length;
  const m = tb.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const aSegs: Seg[] = [];
  const bSegs: Seg[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) {
      pushSeg(aSegs, ta[i], false);
      pushSeg(bSegs, tb[j], false);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushSeg(aSegs, ta[i], true);
      i++;
    } else {
      pushSeg(bSegs, tb[j], true);
      j++;
    }
  }
  while (i < n) pushSeg(aSegs, ta[i++], true);
  while (j < m) pushSeg(bSegs, tb[j++], true);
  return { a: aSegs, b: bSegs };
}

export type DiffLine = { kind: "ctx" | "add" | "del"; text: string };

// Line-level LCS diff between two whole texts — the unified before→after view for
// the Agent Integrations review (a config file's old vs new content). Lines common
// to both are "ctx"; lines only in `before` are "del"; only in `after` are "add".
// O(n·m) on line counts — config files are tiny, so this is comfortably fine.
export function lineDiff(before: string, after: string): DiffLine[] {
  // A trailing newline would otherwise yield a spurious empty final line.
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: a[i++] });
    } else {
      out.push({ kind: "add", text: b[j++] });
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}

type TokKind = "comment" | "string" | "number" | "keyword" | "plain";
export type Tok = { text: string; kind: TokKind };

// A pragmatic cross-language keyword set — enough to give code rhythm without
// per-grammar machinery. Emphasis is monochrome, so a miss is invisible, never
// a wrong colour.
const KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "fn",
  "def",
  "class",
  "struct",
  "enum",
  "interface",
  "type",
  "impl",
  "trait",
  "pub",
  "use",
  "import",
  "from",
  "export",
  "default",
  "return",
  "if",
  "else",
  "elif",
  "for",
  "while",
  "loop",
  "match",
  "switch",
  "case",
  "break",
  "continue",
  "async",
  "await",
  "yield",
  "new",
  "this",
  "self",
  "super",
  "extends",
  "implements",
  "public",
  "private",
  "protected",
  "static",
  "final",
  "void",
  "int",
  "bool",
  "string",
  "true",
  "false",
  "null",
  "nil",
  "none",
  "None",
  "True",
  "False",
  "and",
  "or",
  "not",
  "in",
  "is",
  "as",
  "with",
  "try",
  "catch",
  "except",
  "finally",
  "throw",
  "raise",
  "where",
  "mut",
  "move",
  "ref",
  "go",
  "func",
  "package",
  "namespace",
]);

const TOKEN_RE =
  /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_.eExXa-fA-F]*\b)|([A-Za-z_$][A-Za-z0-9_$]*)|(\s+|[^\sA-Za-z0-9_$]+)/g;

// Tokenize a single line for monochrome emphasis. No multi-line state (a `/*`
// without its close just reads as plain), which is the right trade for a diff
// where each row stands alone.
export function tokenize(line: string): Tok[] {
  const out: Tok[] = [];
  const push = (text: string, kind: TokKind) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ text, kind });
  };
  for (const m of line.matchAll(TOKEN_RE)) {
    if (m[1] !== undefined) push(m[1], "comment");
    else if (m[2] !== undefined) push(m[2], "string");
    else if (m[3] !== undefined) push(m[3], "number");
    else if (m[4] !== undefined) push(m[4], KEYWORDS.has(m[4]) ? "keyword" : "plain");
    else push(m[0], "plain");
  }
  return out;
}

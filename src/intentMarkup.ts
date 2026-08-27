// Rendering helpers for step intents. Kept out of guidePanel so the tests
// can import them: that module pulls in vscode, this one must not.

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


/** LaTeX letters, which absorb the space LaTeX uses to end a command. */
const MATHS_LETTERS: Record<string, string> = {
  Delta: 'Δ', delta: 'δ', pi: 'π', theta: 'θ', lambda: 'λ', mu: 'μ', sigma: 'σ',
  alpha: 'α', beta: 'β', gamma: 'γ', omega: 'ω', infty: '∞',
};
/** LaTeX operators, which keep the spacing they were written with. */
const MATHS_OPERATORS: Record<string, string> = {
  ldots: '…', dots: '…', cdots: '…', times: '×', cdot: '·', div: '÷', pm: '±',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈',
  sum: '∑', int: '∫', to: '→', in: '∈',
};
// Underscores are deliberately left alone. Subscripting them read well on
// "a_0" but the same underscore carries Python identifiers — "time_array",
// "net_total" — and rewriting one of those changes a name the student has to
// type. The gain was cosmetic, the failure silent, so the rule went.
/** Layout-only commands that carry no meaning once the maths is plain text. */
const MATHS_DROPPED = new Set(['left', 'right', 'bigl', 'bigr', 'displaystyle']);
const SUPERSCRIPTS: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶',
  '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', n: 'ⁿ', i: 'ⁱ',
};

/** Transliterate a run of superscript characters, or give up on the run. */
function scriptRun(body: string): string | null {
  const out = [...body].map((ch) => SUPERSCRIPTS[ch]);
  return out.every((ch) => ch !== undefined) ? out.join('') : null;
}

/** Convert the maths in one stretch of prose that contains no code span. */
function convertMaths(text: string): string {
  let out = text.replace(
    /\\(?:frac|dfrac)\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,
    (_match, top: string, bottom: string) => {
      const simple = (part: string) => /^[A-Za-z0-9_.]+$/.test(part.trim());
      return simple(top) && simple(bottom)
        ? `${top.trim()} / ${bottom.trim()}`
        : `(${top.trim()}) / (${bottom.trim()})`;
    }
  );
  out = out.replace(/\\sqrt\s*\{([^{}]*)\}/g, '√$1');
  out = out.replace(/\\(?:text|mathrm|mathit)\s*\{([^{}]*)\}/g, '$1');
  // A letter swallows the space that ended its command only when a word
  // follows, so "\\Delta t" becomes "Δt" while "a \\times b" keeps its spaces.
  out = out.replace(/\\([a-zA-Z]+)( ?)/g, (match, word: string, space: string) => {
    if (MATHS_DROPPED.has(word)) return space;
    const letter = MATHS_LETTERS[word];
    if (letter) return space ? letter : letter;
    const operator = MATHS_OPERATORS[word];
    return operator ? `${operator}${space}` : match;
  });
  out = out.replace(/([A-Za-z0-9)\]])\^\{?([A-Za-z0-9+-]+)\}?/g, (match, head: string, body: string) => {
    const run = scriptRun(body);
    return run === null ? match : head + run;
  });
  out = out.replace(/\$\$([^$\n]+)\$\$/g, '$1');
  return out.replace(/\$([^$\n]+)\$/g, '$1');
}

/**
 * Best-effort LaTeX to Unicode, for display only.
 *
 * The template asks for Unicode maths, but an exercise written in LaTeX pulls
 * the model back towards "$t_k = k \\Delta t$" however the template is worded.
 * The parser already keeps such commands intact rather than letting JSON
 * escaping eat them, so by the time they reach the panel they can simply be
 * transliterated. Anything unrecognised is left exactly as written.
 *
 * Code spans are skipped outright: `time_array` is a Python identifier, and
 * subscripting its underscore would rewrite the name the student must type.
 */
export function mathsToUnicode(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part) => (part.startsWith('`') ? part : convertMaths(part)))
    .join('');
}

/**
 * Render the small Markdown subset step intents may use: "- " bullet lines,
 * **bold**, and `backticks` around names and literal values quoted from the
 * exercise.
 *
 * Escaping runs first and every tag below is one we introduce ourselves, so
 * nothing the model writes can become markup. Deliberately not `marked`:
 * this needs three inline forms rather than a document renderer, and
 * sanitising marked's output on the extension host would mean a new
 * dependency and a DOM that Node does not have.
 */
export function renderIntent(text: string): string {
  const inline = (line: string) =>
    line
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  const html: string[] = [];
  let inList = false;
  for (const line of escapeHtml(mathsToUnicode(text)).split('\n')) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
    if (line.trim()) html.push(`<p>${inline(line)}</p>`);
  }
  if (inList) html.push('</ul>');
  return html.join('');
}


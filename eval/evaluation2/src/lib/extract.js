// Pull runnable Python out of a simulated student's reply.
//
// Small models wrap code in markdown, narrate around it, and sometimes emit
// visible reasoning. This module recovers the code; it deliberately does NOT
// decide whether the code is valid — a SyntaxError is a real student outcome
// and belongs to the sandbox stage, not to a regex here.

/** Remove visible chain-of-thought some local models emit inline. */
function stripThinking(raw) {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|?thinking\|?>[\s\S]*?<\/?\|?thinking\|?>/gi, '');
}

/** All fenced blocks, in order, with their language tag (may be empty). */
function fencedBlocks(text) {
  const blocks = [];
  const re = /```([\w+-]*)\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    blocks.push({ lang: m[1].toLowerCase(), body: m[2] });
  }
  return blocks;
}

/** Does this text plausibly contain code at all? */
function looksLikeCode(text) {
  return /(^|\n)\s*(def |class |import |from \w+ import|for |while |if |print\(|return )/.test(text)
    || /=\s*[^=]/.test(text);
}

/**
 * @returns {{code: string|null, source: 'fenced'|'bare'|'none'}}
 *   source records how the code was recovered, so the analysis can report
 *   how often students needed rescuing from their own formatting.
 */
function extractCode(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { code: null, source: 'none' };
  }
  const text = stripThinking(raw);

  const blocks = fencedBlocks(text);
  if (blocks.length > 0) {
    // Prefer python-tagged blocks; otherwise take untagged ones. A reply may
    // legitimately hold several (a helper plus the main function), so keep
    // them all, in order. Blocks tagged as output/shell are dropped.
    const tagged = blocks.filter((b) => b.lang === 'python' || b.lang === 'py');
    const chosen = tagged.length > 0 ? tagged : blocks.filter((b) => b.lang === '');
    const code = chosen.map((b) => b.body.replace(/\s+$/, '')).join('\n\n').trim();
    if (code !== '') return { code, source: 'fenced' };
  }

  // No usable fence: take the reply as-is if it looks like code at all.
  const bare = text.trim();
  if (looksLikeCode(bare)) return { code: bare, source: 'bare' };

  return { code: null, source: 'none' };
}

module.exports = { extractCode };

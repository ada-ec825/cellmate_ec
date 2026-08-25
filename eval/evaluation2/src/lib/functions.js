'use strict';

function functionBlocks(code) {
  const lines = String(code ?? '').replaceAll('\r\n', '\n').trim().split('\n');
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^def\s+([A-Za-z_]\w*)\s*\(/);
    if (match) starts.push({ index, name: match[1] });
  }
  const blocks = new Map();
  for (let position = 0; position < starts.length; position += 1) {
    const current = starts[position];
    const end = position + 1 < starts.length ? starts[position + 1].index : lines.length;
    blocks.set(current.name, lines.slice(current.index, end).join('\n').trimEnd());
  }
  return blocks;
}

function codePreamble(code) {
  const lines = String(code ?? '').replaceAll('\r\n', '\n').trim().split('\n');
  const firstFunction = lines.findIndex((line) => /^def\s+[A-Za-z_]\w*\s*\(/.test(line));
  if (firstFunction <= 0) return '';
  return lines.slice(0, firstFunction).join('\n').trimEnd();
}

function mergeUnlocked({ currentCode, candidateCode, functionNames, unlocked }) {
  const current = functionBlocks(currentCode);
  const candidate = functionBlocks(candidateCode);
  const preamble = codePreamble(currentCode);
  const allowed = new Set(unlocked);
  if (functionNames.some((name) => !current.has(name))) throw new Error('current scaffold is missing a required function');
  const discardedLockedEdits = [];
  const applied = [];
  const blocks = functionNames.map((name) => {
    const next = candidate.get(name);
    if (allowed.has(name) && next) {
      if (next !== current.get(name)) applied.push(name);
      return next;
    }
    if (!allowed.has(name) && next && next !== current.get(name)) discardedLockedEdits.push(name);
    return current.get(name);
  });
  return {
    code: `${preamble ? `${preamble}\n\n\n` : ''}${blocks.join('\n\n\n')}\n`,
    applied,
    discardedLockedEdits,
    candidateFunctions: [...candidate.keys()],
  };
}

function lockedFunctions(functionNames, unlocked) {
  const allowed = new Set(unlocked);
  return functionNames.filter((name) => !allowed.has(name));
}

function lockedIntegrity({ beforeCode, afterCode, functionNames, unlocked }) {
  const before = functionBlocks(beforeCode);
  const after = functionBlocks(afterCode);
  return lockedFunctions(functionNames, unlocked).every((name) => before.get(name) === after.get(name));
}

function buildD10Prompt({ capability, statement, goalLabels, functionNames, currentCode, currentGoal, unlocked, round, rounds, feedback }) {
  if (!currentGoal && round !== rounds) throw new Error('only the final round may omit a current goal');
  const catalogue = [...functionNames].sort().map((name) => `- ${name}: ${goalLabels[name]}`);
  const instruction = currentGoal
    ? [
        `Current unlocked goal: ${currentGoal} — ${goalLabels[currentGoal]}`,
        `The harness will retain edits to: ${unlocked.join(', ')}.`,
        'You may revise any previously unlocked function as well as the current one. Edits to other visible functions will not be retained yet.',
      ]
    : [
        'Final integration round: all five functions are unlocked.',
        'Repair any remaining issue anywhere in the complete solution while preserving passing behavior.',
      ];
  return [
    capability.trim(),
    '',
    '--- Complete exercise; no information is hidden ---',
    statement.trim(),
    '',
    '--- Goal catalogue (alphabetical display is not a recommended workflow) ---',
    ...catalogue,
    '',
    '--- Current cumulative code ---',
    '```python',
    currentCode.trim(),
    '```',
    '',
    `--- Construction round ${round} of ${rounds} ---`,
    ...instruction,
    '',
    '--- Automated diagnostic on the retained code ---',
    feedback.trim(),
    '',
    'Return the complete five-function solution. Earlier unlocked code is not immutable and may be repaired.',
    'Do not print, run examples, assertions, or tests at top level.',
    'Reply with one Python code block and nothing else.',
  ].join('\n');
}

module.exports = { buildD10Prompt, codePreamble, functionBlocks, lockedFunctions, lockedIntegrity, mergeUnlocked };

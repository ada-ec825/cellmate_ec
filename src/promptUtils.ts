import * as vscode from 'vscode';

/**
 * Extract prompt ID from code comments
 */
export function extractPromptId(code: string): string | null {
  const m = code.match(/^[ \t]*#\s*PROMPT_ID\s*:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

/**
 * Extract exercise ID from code comments
 */
export function extractExerciseId(code: string): string | null {
  const m = code.match(/^\s*#\s*EXERCISE_ID\s*:\s*([A-Za-z0-9_\-]+)/m);
  return m ? m[1] : null;
}

/**
 * Get all placeholder keys from a template string
 */
export function getTemplatePlaceholderKeys(template: string): Set<string> {
  const keys = new Set<string>();
  const regex = /\{\{([\w\-:+=]+)\}\}/g;
  let match;
  while ((match = regex.exec(template)) !== null) {
    keys.add(match[1]);
  }
  return keys;
}

/**
 * Extract all cell prompt placeholder content, supporting <!-- prompt:key -->, # prompt:key, and multi-block sections
 */
export function extractPromptPlaceholders(notebook: vscode.NotebookDocument, currentCellIdx: number, placeholderKeys?: Set<string>): Map<string, string> {
  const placeholderMap = new Map<string, string>();
  let hadWarning = false;
  const chosen = new Map<string, { distance: number, value: string }>();
  const htmlCommentRe = /<!--\s*prompt:\s*([\w\-]+)\s*-->/g;
  const hashCommentRe = /^\s*#\s*prompt:\s*([\w\-]+)\s*$/gm;
  const blockStartRe = /<!--\s*prompt:\s*([\w\-]+):start\s*-->/g;
  const blockEndRe = /<!--\s*prompt:\s*([\w\-]+):end\s*-->/g;

  const blockAnyRe = /<!--\s*prompt:\s*([\w\-]+):(start|end)\s*-->/g;
  const openCounts = new Map<string, number>();
  for (let i = 0; i < notebook.cellCount; ++i) {
    const cell = notebook.cellAt(i);
    const text = cell.document.getText();
    blockAnyRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = blockAnyRe.exec(text)) !== null) {
      const key = m[1];
      const type = m[2];
      if (type === 'start') {
        openCounts.set(key, (openCounts.get(key) || 0) + 1);
      } else {
        const cnt = openCounts.get(key) || 0;
        if (cnt <= 0) {
          vscode.window.showWarningMessage(`Multi-block error: found end without matching start for key "${key}" in cell ${i}`);
          hadWarning = true;
        }
        openCounts.set(key, cnt - 1);
      }
    }
  }
  const unclosedKeys = Array.from(openCounts.entries())
    .filter(([, count]) => count > 0)
    .map(([key]) => key);
  if (unclosedKeys.length > 0) {
    vscode.window.showWarningMessage(`Multi-block error: missing end for key(s): ${unclosedKeys.join(', ')}`);
    hadWarning = true;
  }

  for (let i = currentCellIdx; i >= 0; --i) {
    const cell = notebook.cellAt(i);
    const text = cell.document.getText();

    let match: RegExpExecArray | null;
    while ((match = htmlCommentRe.exec(text)) !== null) {
      const key = match[1];
      const afterComment = text.substring(match.index + match[0].length).trim();
      const distance = currentCellIdx - i;
      if (distance >= 0) {
        const prev = chosen.get(key);
        if (!prev || distance < prev.distance) {
          chosen.set(key, { distance, value: afterComment });
        }
      }
    }
    while ((match = hashCommentRe.exec(text)) !== null) {
      const key = match[1];
      const afterComment = text.substring(match.index + match[0].length).trim();
      const distance = currentCellIdx - i;
      if (distance >= 0) {
        const prev = chosen.get(key);
        if (!prev || distance < prev.distance) {
          chosen.set(key, { distance, value: afterComment });
        }
      }
    }
  }

  const section2Counts = new Map<string, number>();
  const section2Duplicates = new Set<string>();
  for (let i = 0; i < notebook.cellCount; ++i) {
    const cell = notebook.cellAt(i);
    const text = cell.document.getText();
    let mStart: RegExpExecArray | null;
    blockStartRe.lastIndex = 0;
    while ((mStart = blockStartRe.exec(text)) !== null) {
      const k = mStart[1];
      const cnt = (section2Counts.get(k) || 0) + 1;
      section2Counts.set(k, cnt);
      if (cnt > 1) section2Duplicates.add(k);
    }
  }
  const processedBlockKeys = new Set<string>();
  for (let i = currentCellIdx; i >= 0; --i) {
    const cell = notebook.cellAt(i);
    const text = cell.document.getText();
    let startMatch: RegExpExecArray | null;
    blockStartRe.lastIndex = 0;
    while ((startMatch = blockStartRe.exec(text)) !== null) {
      const key = startMatch[1];
      if (processedBlockKeys.has(key)) continue;

      let content = '';
      let foundEnd = false;
      let crossedCurrent = false;
      for (let j = i; j < notebook.cellCount; ++j) {
        const c = notebook.cellAt(j);
        const t = c.document.getText();

        if (j === i) {
          const afterStart = t.split(startMatch[0])[1] || '';
          blockEndRe.lastIndex = 0;
          const endInSame = blockEndRe.exec(afterStart);
          if (endInSame && endInSame[1] === key) {
            const beforeEnd = afterStart.split(endInSame[0])[0] || '';
            content += beforeEnd + '\n';
            foundEnd = true;
          } else {
            content += afterStart + '\n';
          }
        } else {
          blockEndRe.lastIndex = 0;
          const endMatch = blockEndRe.exec(t);
          if (endMatch && endMatch[1] === key) {
            if (j >= currentCellIdx) {
              crossedCurrent = true;
            } else {
              const beforeEnd = t.split(endMatch[0])[0] || '';
              content += beforeEnd + '\n';
              foundEnd = true;
            }
            break;
          } else {
            content += t + '\n';
          }
        }
      }
      if (crossedCurrent) {
        vscode.window.showWarningMessage(`Multi-block warning: key "${key}" has start above and end below the current cell.`);
        hadWarning = true;
      }
      if (foundEnd) {
        const distance = currentCellIdx - i;
        const prev = chosen.get(key);
        const value = content.trim() + '\n';
        if (!prev || distance < prev.distance) {
          chosen.set(key, { distance, value });
        }
      } else {
        vscode.window.showWarningMessage(`Multi-block error: missing end for key "${key}" starting from cell ${i}`);
        hadWarning = true;
      }
      processedBlockKeys.add(key);
    }
  }

  for (const [k, sel] of chosen.entries()) {
    placeholderMap.set(k, sel.value);
  }

  const section3Counts = new Map<string, number>();
  const section3Duplicates = new Set<string>();
  const cellRefPatterns = [
    /prompt:\s*(cell:this)/g,

    /prompt:\s*(cell:-?\d+:(md|cd))/g,
    /prompt:\s*(cell:\+\d+:(md|cd))/g,
    /prompt:\s*(cell:[1-9]\d*:(md|cd))/g,

    /prompt:\s*(cell:-?\d+(?!:))/g,
    /prompt:\s*(cell:\+\d+(?!:))/g,
    /prompt:\s*(cell:[1-9]\d*(?!:))/g
  ];

  if (currentCellIdx >= 0 && currentCellIdx < notebook.cellCount) {
    const cell = notebook.cellAt(currentCellIdx);
    const text = cell.document.getText();
    for (const pattern of cellRefPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(match => {
          const key = match.replace(/^prompt:\s*/, '');
          if (!placeholderKeys || placeholderKeys.has(key)) {
            placeholderMap.set(key, '');
            const cnt = (section3Counts.get(key) || 0) + 1;
            section3Counts.set(key, cnt);
            if (cnt > 1) section3Duplicates.add(key);
          }
        });
      }
    }
  }

  const dup2 = Array.from(section2Duplicates);
  const dup3 = Array.from(section3Duplicates);
  if (dup2.length > 0) {
    vscode.window.showWarningMessage(`detected duplicate prompt key in multi-block definition: ${dup2.join(', ')}. Please do not use the same key to avoid confusion.`);
    hadWarning = true;
  }
  if (dup3.length > 0) {
    vscode.window.showWarningMessage(`detected duplicate prompt key (cell reference): ${dup3.join(', ')}. Please do not use the same key to avoid confusion.`);
    hadWarning = true;
  }

  if (hadWarning) {
    throw new Error('Prompt extraction aborted due to warnings. Please resolve warnings and try again.');
  }

  placeholderMap.set('__currentCellIdx__', String(currentCellIdx));

  return placeholderMap;
}

/**
 * Fill the template, only replace the placeholders that are declared in the notebook
 */
export function fillPromptTemplate(template: string, placeholderMap: Map<string, string>, notebook: vscode.NotebookDocument): string {
  let result = template.replace(/\{\{([\w\-:+=]+)\}\}/g, (_m, key) => {
    let cellMatch;

    if (placeholderMap.has(key)) {
      if (key.startsWith('cell:')) {
        const currentIdx = Number(placeholderMap.get('__currentCellIdx__') || 0);
        if ((cellMatch = key.match(/^cell:([+-]\d+):(md|cd)$/))) {
          const rel = Number(cellMatch[1]);
          const type = cellMatch[2];
          let foundIdx = -1;
          let count = Math.abs(rel);
          if (rel > 0) {
            // Search downward
            for (let i = currentIdx + 1; i < notebook.cellCount; ++i) {
              const cell = notebook.cellAt(i);
              if ((type === 'md' && cell.kind === vscode.NotebookCellKind.Markup) ||
                  (type === 'cd' && cell.kind === vscode.NotebookCellKind.Code)) {
                count--;
                if (count === 0) {
                  foundIdx = i;
                  break;
                }
              }
            }
          } else {
            // Search upward
            for (let i = currentIdx - 1; i >= 0; --i) {
              const cell = notebook.cellAt(i);
              if ((type === 'md' && cell.kind === vscode.NotebookCellKind.Markup) ||
                  (type === 'cd' && cell.kind === vscode.NotebookCellKind.Code)) {
                count--;
                if (count === 0) {
                  foundIdx = i;
                  break;
                }
              }
            }
          }
          if (foundIdx >= 0 && foundIdx < notebook.cellCount) {
            const content = notebook.cellAt(foundIdx).document.getText();
            return content;
          } else {
            return '';
          }
        }
        else if ((cellMatch = key.match(/^cell:([+-]\d+)$/))) {
          const rel = Number(cellMatch[1]);
          const targetIdx = currentIdx + rel;
          if (targetIdx >= 0 && targetIdx < notebook.cellCount) {
            const content = notebook.cellAt(targetIdx).document.getText();
            return content;
          } else {
            return '';
          }
        }
        else if ((cellMatch = key.match(/^cell:(\d+)(?::(md|cd))?$/))) {
          const absIdx = Number(cellMatch[1]);
          const type = cellMatch[2];
          let foundIdx = -1, count = 0;
          for (let i = 0; i < notebook.cellCount; ++i) {
            const cell = notebook.cellAt(i);
            if (!type || (type === 'md' && cell.kind === vscode.NotebookCellKind.Markup) ||
                (type === 'cd' && cell.kind === vscode.NotebookCellKind.Code)) {
              count++;
              if (count === absIdx) {
                foundIdx = i;
                break;
              }
            }
          }
          if (foundIdx >= 0 && foundIdx < notebook.cellCount) {
            const content = notebook.cellAt(foundIdx).document.getText();
            return content;
          } else {
            return '';
          }
        }
      }

      const value = placeholderMap.get(key) ?? '';
      return value;
    }
    return '';
  });

  result = result.replace(/[ \t]*(\r?\n)(?:[ \t]*\r?\n)+/g, '$1$1');
  return result;
} 

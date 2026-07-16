import * as vscode from 'vscode';
import { Decomposition } from './schema';
import { ProgressCheckResult, StepVerdict } from './stepCheck';

/**
 * Side effects the panel raises but does not own. The command layer wires
 * these to the progress-check engine, state persistence and telemetry,
 * keeping the panel a dumb view of one decomposition.
 */
export interface GuidePanelHooks {
  /** The student asked for a progress check against their current code. */
  onCheckProgress?(): void;
  /** The student asked for a fresh decomposition. */
  onRegenerate?(): void;
}

/**
 * Webview panel showing the whole decomposition at once — the plan IS the
 * help, so nothing is hidden or gated. A progress check marks each step
 * (· unchecked, ✓ addressed, △ needs attention) and shows one short
 * remark; verdicts are advisory and never block anything. Shows labels,
 * intents and time shares only — never code, and not checkHint either
 * (that field belongs to the checker, not to the student).
 */
export class GuidePanel {
  public static currentPanel: GuidePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private decomposition: Decomposition;
  private hooks: GuidePanelHooks;
  /** Latest check verdicts; null until the first check of this plan. */
  private verdicts: StepVerdict[] | null = null;
  private feedback: string | null = null;
  private checking = false;

  public static createOrShow(
    decomposition: Decomposition,
    _initialStep = 1, // deprecated, ignored: all steps are always visible
    hooks: GuidePanelHooks = {}
  ): GuidePanel {
    const column = vscode.ViewColumn.Two;

    if (GuidePanel.currentPanel) {
      GuidePanel.currentPanel.panel.reveal(column);
      GuidePanel.currentPanel.hooks = hooks;
      GuidePanel.currentPanel.setDecomposition(decomposition);
      return GuidePanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'cellmateGuide',
      'CellMate Guide',
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    GuidePanel.currentPanel = new GuidePanel(panel, decomposition, hooks);
    return GuidePanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    decomposition: Decomposition,
    hooks: GuidePanelHooks
  ) {
    this.panel = panel;
    this.decomposition = decomposition;
    this.hooks = hooks;

    this.update();

    this.panel.onDidDispose(() => this.dispose(), null);
    this.panel.webview.onDidReceiveMessage((message: { command: string }) => {
      switch (message.command) {
        case 'check':
          if (!this.checking) {
            this.checking = true;
            this.update();
            this.hooks.onCheckProgress?.();
          }
          break;
        case 'regenerate':
          this.hooks.onRegenerate?.();
          break;
        default:
          console.warn('Unknown guide panel command:', message.command);
      }
    });
  }

  /** Replace the plan (e.g. after regeneration); clears all check marks. */
  public setDecomposition(decomposition: Decomposition, _revealed = 1): void {
    this.decomposition = decomposition;
    this.verdicts = null;
    this.feedback = null;
    this.checking = false;
    this.update();
  }

  /**
   * The wiring calls this when a progress check finishes. A null result
   * (fail-open path) keeps existing marks and shows a soft notice.
   */
  public showProgress(result: ProgressCheckResult | null): void {
    this.checking = false;
    if (result) {
      this.verdicts = result.verdicts;
      this.feedback = result.feedback;
    } else {
      this.feedback = 'Could not check this time — carry on.';
    }
    this.update();
  }

  private update(): void {
    this.panel.title = `CellMate Guide: ${this.decomposition.exerciseId}`;
    this.panel.webview.html = this.render();
  }

  private render(): string {
    const d = this.decomposition;
    const doneCount = this.verdicts
      ? this.verdicts.filter((v) => v.status === 'done').length
      : 0;
    // The frontier — first step not cleanly done — gets the highlight.
    const frontier = this.verdicts
      ? this.verdicts.findIndex((v) => v.status !== 'done')
      : 0;

    const stepsHtml = d.steps
      .map((s, i) => {
        const status = this.verdicts?.[i]?.status;
        const stateClass = status === 'done' ? ' done' : status === 'issue' ? ' flagged' : '';
        const currentClass = i === frontier ? ' current' : '';
        const marker = status === 'done' ? '&#10003;' : status === 'issue' ? '&#9888;' : '&#183;';
        const note = this.verdicts?.[i]?.note
          ? `<div class="note">${escapeHtml(this.verdicts[i].note!)}</div>`
          : '';
        const share =
          typeof s.timeShare === 'number'
            ? `<span class="share-label">~${Math.round(s.timeShare)}% of your time</span>`
            : '';
        return `<li class="step${stateClass}${currentClass}">
          <div class="label"><span class="marker">${marker}</span>Step ${s.index}: ${escapeHtml(s.label)} ${share}</div>
          <div class="intent">${escapeHtml(s.intent)}</div>
          ${note}
        </li>`;
      })
      .join('\n');

    const banner = this.feedback
      ? `<div class="banner">&#128172; ${escapeHtml(this.feedback)}</div>`
      : '';

    const progressNote = this.verdicts
      ? `${doneCount}/${d.steps.length} steps addressed`
      : `${d.steps.length} steps`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    padding: 12px 16px;
  }
  .header {
    font-size: 13px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 12px;
  }
  ol.steps { list-style: none; padding: 0; margin: 0; }
  .step {
    padding: 10px 12px;
    margin-bottom: 8px;
    border-radius: 6px;
    border-left: 3px solid var(--vscode-panel-border);
    background: var(--vscode-editor-hoverHighlightBackground);
  }
  .step.current { border-left-color: var(--vscode-textLink-foreground); }
  .step.done { opacity: 0.75; }
  .step.done .marker { color: var(--vscode-charts-green, #4caf50); }
  .step.flagged .marker { color: var(--vscode-editorWarning-foreground, #e0a93b); }
  .note {
    font-size: 12px;
    line-height: 1.4;
    color: var(--vscode-editorWarning-foreground, #e0a93b);
    margin: 3px 0 0 1.1em;
  }
  .marker { display: inline-block; width: 1.1em; font-weight: 700; }
  .label { font-weight: 600; margin-bottom: 4px; }
  .share-label {
    font-size: 11px;
    font-weight: 400;
    color: var(--vscode-descriptionForeground);
    margin-left: 6px;
  }
  .intent { font-size: 13px; line-height: 1.5; margin-left: 1.1em; }
  .banner {
    margin-top: 12px;
    padding: 10px 12px;
    border-radius: 6px;
    border-left: 3px solid var(--vscode-textLink-foreground);
    background: var(--vscode-editor-hoverHighlightBackground);
    font-size: 13px;
    line-height: 1.5;
  }
  .buttons { margin-top: 14px; display: flex; gap: 8px; }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    padding: 6px 12px;
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
</style>
</head>
<body>
  <div class="header">
    Exercise <b>${escapeHtml(d.exerciseId)}</b>
    &middot; plan source: ${escapeHtml(d.source)}
    &middot; ${progressNote}
  </div>
  <ol class="steps">
${stepsHtml}
  </ol>
  ${banner}
  <div class="buttons">
    <button id="check" ${this.checking ? 'disabled' : ''}>${
      this.checking ? 'Checking&#8230;' : 'Check my progress'
    }</button>
    <button id="regenerate" class="secondary">Regenerate</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    for (const id of ['check', 'regenerate']) {
      document.getElementById(id).addEventListener('click', () => {
        vscode.postMessage({ command: id });
      });
    }
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    GuidePanel.currentPanel = undefined;
    this.panel.dispose();
  }
}

/** Escape text for safe interpolation into the webview HTML. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

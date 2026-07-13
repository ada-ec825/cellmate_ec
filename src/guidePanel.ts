import * as vscode from 'vscode';
import { Decomposition } from './schema';

/**
 * Side effects the panel raises but does not own. The command layer wires
 * these to state persistence, telemetry and regeneration, keeping the
 * panel a dumb view of one decomposition.
 */
export interface GuidePanelHooks {
  /** A further step became visible; `step` is the new 1-based count. */
  onStepRevealed?(step: number): void;
  /** The student restarted the guide from step 1. */
  onReset?(): void;
  /** The student asked for a fresh decomposition. */
  onRegenerate?(): void;
}

/**
 * Webview panel that reveals a decomposition one step at a time.
 * Shows labels and intents only — never code, and not checkHint either
 * (that field belongs to step_check, not to the student).
 */
export class GuidePanel {
  public static currentPanel: GuidePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private decomposition: Decomposition;
  private revealed: number;
  private hooks: GuidePanelHooks;

  public static createOrShow(
    decomposition: Decomposition,
    initialRevealed = 1,
    hooks: GuidePanelHooks = {}
  ): GuidePanel {
    const column = vscode.ViewColumn.Two;

    if (GuidePanel.currentPanel) {
      GuidePanel.currentPanel.panel.reveal(column);
      GuidePanel.currentPanel.hooks = hooks;
      GuidePanel.currentPanel.setDecomposition(decomposition, initialRevealed);
      return GuidePanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'cellmateGuide',
      'CellMate Guide',
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    GuidePanel.currentPanel = new GuidePanel(panel, decomposition, initialRevealed, hooks);
    return GuidePanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    decomposition: Decomposition,
    initialRevealed: number,
    hooks: GuidePanelHooks
  ) {
    this.panel = panel;
    this.decomposition = decomposition;
    this.revealed = this.clampRevealed(initialRevealed);
    this.hooks = hooks;

    this.update();

    this.panel.onDidDispose(() => this.dispose(), null);
    this.panel.webview.onDidReceiveMessage((message: { command: string }) => {
      switch (message.command) {
        case 'next':
          if (this.revealed < this.decomposition.steps.length) {
            this.revealed++;
            this.hooks.onStepRevealed?.(this.revealed);
            this.update();
          }
          break;
        case 'reset':
          this.revealed = 1;
          this.hooks.onReset?.();
          this.update();
          break;
        case 'regenerate':
          this.hooks.onRegenerate?.();
          break;
        default:
          console.warn('Unknown guide panel command:', message.command);
      }
    });
  }

  /** Replace the plan (e.g. after regeneration) and re-render. */
  public setDecomposition(decomposition: Decomposition, revealed = 1): void {
    this.decomposition = decomposition;
    this.revealed = this.clampRevealed(revealed);
    this.update();
  }

  private clampRevealed(n: number): number {
    return Math.min(Math.max(1, n), this.decomposition.steps.length);
  }

  private update(): void {
    this.panel.title = `CellMate Guide: ${this.decomposition.exerciseId}`;
    this.panel.webview.html = this.render();
  }

  private render(): string {
    const d = this.decomposition;
    const allRevealed = this.revealed >= d.steps.length;

    const stepsHtml = d.steps
      .map((s) => {
        if (s.index > this.revealed) {
          return `<li class="step locked">Step ${s.index} &#128274;</li>`;
        }
        const current = s.index === this.revealed ? ' current' : '';
        return `<li class="step${current}">
          <div class="label">Step ${s.index}: ${escapeHtml(s.label)}</div>
          <div class="intent">${escapeHtml(s.intent)}</div>
        </li>`;
      })
      .join('\n');

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
  .step.locked {
    color: var(--vscode-descriptionForeground);
    background: none;
    border-left-style: dashed;
  }
  .label { font-weight: 600; margin-bottom: 4px; }
  .intent { font-size: 13px; line-height: 1.5; }
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
    &middot; ${this.revealed}/${d.steps.length} steps shown
  </div>
  <ol class="steps">
${stepsHtml}
  </ol>
  <div class="buttons">
    <button id="next" ${allRevealed ? 'disabled' : ''}>Show next step</button>
    <button id="reset" class="secondary">Start over</button>
    <button id="regenerate" class="secondary">Regenerate</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    for (const id of ['next', 'reset', 'regenerate']) {
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

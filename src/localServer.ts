import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import extract from 'extract-zip';
import * as vscode from 'vscode';

let ctx: vscode.ExtensionContext | undefined;
export function setExtensionContext(c: vscode.ExtensionContext) {
  ctx = c;
}

export function getSttPort(): number {
  if (!ctx) return 5000;
  return ctx.globalState.get<number>(STT_PORT_KEY) ?? 5000;
}

const TINY_ZIP  = 'https://github.com/teachnology/cellmate/releases/download/v0.1-tiny/whisper_srv_tiny_mac.zip';
let PORT = 5000;
let srv: ChildProcess | null = null;

export const STT_PORT_KEY = 'jaif.sttPort';

const exists = async (p: string) => !!(await fs.stat(p).catch(() => undefined));
const portAlive = (p: number) =>
  fetch(`http://127.0.0.1:${p}/health`).then(r => r.ok).catch(() => false);

function canListen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function findFreePort(start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port++) {
    if (await canListen(port)) {
      return port;
    }
  }
  throw new Error(`No free local STT port found in range ${start}-${end}`);
}

async function downloadAndExtract(url: string, dest: string) {
  await fs.mkdir(dest, { recursive: true });
  const zipTmp = path.join(dest, 'tmp.zip');
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  await fs.writeFile(zipTmp, buf);
  await extract(zipTmp, { dir: dest });
  await fs.rm(zipTmp);
}

function waitUntil(cond: () => Promise<boolean>, ms: number) {
  const t0 = Date.now();
  return new Promise<void>((ok, bad) => {
    (async function loop() {
      if (await cond()) return ok();
      if (Date.now() - t0 > ms) return bad();
      setTimeout(loop, 1000);
    })();
  });
}

export async function ensureLocalServer() {
  if (!ctx) { throw new Error('Extension context not set'); }
  PORT = ctx.globalState.get(STT_PORT_KEY) ?? 5000;
  if (await portAlive(PORT)) return true;

  PORT = await findFreePort(5000, 5100);

  const choice = await vscode.window.showInformationMessage(
    'Local speech-to-text model is not installed.\n' +
    'The first-time download is ~240 MB and runs completely offline.',
    'Install & run the local model',
    'Use a cloud provider instead'
  );
  if (choice === 'Use a cloud provider instead') {
    vscode.commands.executeCommand(
      'workbench.action.openSettings',
      'CellMate.speechProvider'
    );
    return false;
  }
  if (choice !== 'Install & run the local model') return false;

  const model = 'tiny';
  const root = path.join(process.env.HOME || '', '.jaif', model);
  if (!(await exists(path.join(root, 'run_whisper_server.py')))) {
    const zip = TINY_ZIP; 
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading tiny model…` },
      () => downloadAndExtract(zip, root)
    );
  }

  const py = path.join(root, 'venv', 'bin', 'python');
  srv = spawn(py, ['run_whisper_server.py', '--port', PORT.toString(), '--model', model], {
    cwd: root, stdio: 'ignore'
  });

  try {
    await waitUntil(() => portAlive(PORT), 20000);
    if (!ctx) { throw new Error('Extension context not set'); }
    await ctx.globalState.update(STT_PORT_KEY, PORT);
    vscode.window.showInformationMessage(`Local tiny model ready (port ${PORT}) ✓`);
    return true;
  } catch {
    vscode.window.showErrorMessage('Failed to start local STT service');
    return false;
  }
}

export function killLocal() {
  srv?.kill();
}

// Run a simulated student's code against an exercise's hidden tests.
//
// pytest is the only outcome judge in this evaluation. This runner provides
// process hygiene (a private temp directory, an allowlisted environment,
// resource limits, bounded output, and process-group cleanup), but it is NOT
// an operating-system security boundary. In particular, pytest and the
// submission still execute in the same process, so the submission can read
// test_hidden.py. New confirmatory runs must put this runner inside a
// network-disabled container/VM and must separately solve hidden-test
// confidentiality. See sandbox_canary.js: the unresolved boundaries fail
// there deliberately instead of being described as "sandboxed" here.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const MIB = 1024 * 1024;

// These are per-process/descendant limits, not a disk quota or a container
// cgroup. Callers may lower them for a particular exercise but may not raise
// them above these caps.
const LIMIT_CAPS = Object.freeze({
  addressSpaceBytes: 4 * 1024 * MIB,
  fileBytes: 16 * MIB,
  openFiles: 128,
  processes: 128,
  outputBytes: 1 * MIB,
});

// Start from an empty object and copy only locale/timezone values. Never pass
// API keys, HOME, proxy settings, Python startup hooks, or service tokens into
// student code. HOME/TMPDIR/PATH below are controlled values, not inherited.
const INHERITED_ENV_ALLOWLIST = Object.freeze(['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']);

// Python's resource module is the smallest portable-to-Unix way to apply
// limits before pytest starts. The status file lets the parent fail closed if
// the launcher could not apply every requested limit.
const RESOURCE_LAUNCHER = `import json, os, resource, sys

limits = json.loads(sys.argv[1])
status_path = sys.argv[2]
python_exec = sys.argv[3]
python_argv0 = sys.argv[4]
python_args = sys.argv[5:]

resources = (
    ("cpuSeconds", "RLIMIT_CPU"),
    ("fileBytes", "RLIMIT_FSIZE"),
    ("openFiles", "RLIMIT_NOFILE"),
)

applied = {}
try:
    for key, resource_name in resources:
        resource_id = getattr(resource, resource_name, None)
        if resource_id is None:
            raise RuntimeError(f"{resource_name} is unavailable")
        requested = int(limits[key])
        _, hard = resource.getrlimit(resource_id)
        cap = requested if hard == resource.RLIM_INFINITY else min(requested, int(hard))
        if cap <= 0:
            raise RuntimeError(f"invalid effective limit for {resource_name}: {cap}")
        resource.setrlimit(resource_id, (cap, cap))
        applied[key] = cap
    # macOS Python maps a very large shared address range before this launcher
    # runs, so lowering RLIMIT_AS fails with EINVAL and is not a memory cap.
    # RLIMIT_NPROC is per-UID on macOS. Lowering it in a shared desktop login
    # can fail merely because unrelated applications already exceed the cap,
    # so neither value is used as a containment claim. The strict Seatbelt
    # profile denies process-fork; a future container backend must apply both
    # --memory and --pids-limit.
    applied["addressSpaceBytes"] = None
    applied["processes"] = None
    with open(status_path, "x", encoding="utf8") as handle:
        json.dump(applied, handle, sort_keys=True)
except BaseException as exc:
    print(f"cellmate resource launcher failed: {type(exc).__name__}: {exc}", file=sys.stderr)
    raise SystemExit(125)

os.execv(python_exec, [python_argv0, *python_args])
`;

// macOS Seatbelt profile. sandbox-exec is deprecated but remains the only
// locally available kernel boundary on the current evaluation host. This
// profile is deny-by-default: it exposes the per-run directory, the selected
// virtualenv/interpreter, and standard system/runtime paths; it does not grant
// network access, process-fork, or writes outside TASK_DIR.
//
// Hidden-test confidentiality is intentionally not claimed: test_hidden.py is
// inside TASK_DIR because pytest and the submission still share one process.
function macosSandboxProfile({ taskDir, venvRoot, pythonPath, realPython, pythonExec }) {
  // JSON string literals are valid Scheme/SBPL strings and safely escape any
  // whitespace or backslash in a path. Rendering concrete paths avoids
  // sandbox-exec treating an absent/false parameter as a path-filter boolean.
  const q = (value) => JSON.stringify(value);
  return `(version 1)
(deny default)
(import "system.sb")
(deny network*)

(allow process-exec
  (literal ${q(pythonPath)})
  (literal ${q(realPython)})
  (literal ${q(pythonExec)}))

; realpath(3) must stat each ancestor before it reaches the specifically
; allowed venv/task subtree. This permits metadata probes, not directory
; contents or file data outside the read allowlist below.
(allow file-read-metadata file-test-existence)

(allow file-read* file-test-existence file-map-executable
  (subpath ${q(taskDir)})
  (subpath ${q(venvRoot)})
  (subpath ${q(path.dirname(realPython))})
  (subpath "/opt/homebrew")
  (subpath "/Library/Fonts")
  (subpath "/Library/Frameworks"))

(allow file-write* file-test-existence
  (subpath ${q(taskDir)}))

(allow ipc-posix-shm)
`;
}

/**
 * Loads the submission so that a crash in module-level driver code does not
 * erase the definitions above it.
 *
 * Plans legitimately tell students to demonstrate their work "outside the
 * function", so submissions end in driver code. Importing normally means one
 * bad driver line zeroes an otherwise correct solution — a grading artefact
 * no human marker would produce, and one that biases every measurement
 * against plans. Here the module body is executed manually: whatever was
 * defined before the crash stays importable, and the crash itself is
 * recorded rather than propagated. A SyntaxError still defines nothing and
 * still fails everything, which is the correct verdict.
 */
const CONFTEST = `import sys, types, traceback

mod = types.ModuleType("submission")
mod.__file__ = "submission.py"
src = open("submission.py", encoding="utf8").read()
crash = None
try:
    exec(compile(src, "submission.py", "exec"), mod.__dict__)
except BaseException:
    crash = traceback.format_exc()
mod.__submission_crash__ = crash
sys.modules["submission"] = mod
if crash is not None:
    with open("driver_crash.txt", "w", encoding="utf8") as fh:
        fh.write(crash)
`;

/** First student-readable line of a failure, for round-based feedback. */
function firstFailureLine(test) {
  const longrepr = test?.call?.longrepr ?? test?.longrepr ?? '';
  const text = typeof longrepr === 'string' ? longrepr : longrepr?.longrepr ?? '';
  const crash = typeof longrepr === 'object' ? longrepr?.reprcrash?.message : null;
  if (crash) return String(crash).split('\n')[0].trim();
  const lines = String(text).split('\n');
  const assertLine = lines.find((l) => /AssertionError|^E\s+/.test(l));
  return (assertLine ?? lines[0] ?? '').trim().slice(0, 300);
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function effectiveLimits(timeoutMs, requested = {}) {
  positiveInteger(timeoutMs, 'timeoutMs');
  const lowerOnly = (name) => {
    const cap = LIMIT_CAPS[name];
    const value = requested[name] === undefined ? cap : positiveInteger(requested[name], `limits.${name}`);
    return Math.min(value, cap);
  };
  const cpuCap = Math.max(2, Math.ceil(timeoutMs / 1000) + 2);
  const requestedCpu =
    requested.cpuSeconds === undefined
      ? cpuCap
      : positiveInteger(requested.cpuSeconds, 'limits.cpuSeconds');
  return Object.freeze({
    cpuSeconds: Math.min(requestedCpu, cpuCap),
    addressSpaceBytes: lowerOnly('addressSpaceBytes'),
    fileBytes: lowerOnly('fileBytes'),
    openFiles: lowerOnly('openFiles'),
    processes: lowerOnly('processes'),
    outputBytes: lowerOnly('outputBytes'),
  });
}

function childEnvironment(dir, pyVenvLauncher = null) {
  const env = Object.create(null);
  for (const name of INHERITED_ENV_ALLOWLIST) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const controlled = {
    ...env,
    HOME: dir,
    TMPDIR: dir,
    TMP: dir,
    TEMP: dir,
    PATH: '/usr/bin:/bin',
    MPLBACKEND: 'Agg',
    MPLCONFIGDIR: path.join(dir, '.matplotlib'),
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONHASHSEED: '0',
    PYTHONNOUSERSITE: '1',
    PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1',
  };
  if (pyVenvLauncher !== null) {
    // Controlled value, never inherited. It lets the Python.app Mach-O use the
    // selected venv without invoking Homebrew's posix_spawn wrapper.
    controlled.__PYVENV_LAUNCHER__ = pyVenvLauncher;
  }
  return controlled;
}

function pythonExecutionPath(pythonPath) {
  const realPython = fs.realpathSync(pythonPath);
  if (process.platform !== 'darwin') return realPython;
  const frameworkApp = path.resolve(
    path.dirname(realPython),
    '..',
    'Resources',
    'Python.app',
    'Contents',
    'MacOS',
    'Python'
  );
  return fs.existsSync(frameworkApp) ? frameworkApp : realPython;
}

function assertPlainDataTree(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`dataDir must not contain symbolic links: ${current}`);
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
    } else if (!stat.isFile()) {
      throw new Error(`dataDir contains a non-regular file: ${current}`);
    }
  }
}

function terminateProcessGroup(proc) {
  if (!proc || !proc.pid) return false;
  if (process.platform !== 'win32') {
    try {
      process.kill(-proc.pid, 'SIGKILL');
      return true;
    } catch (err) {
      if (err.code !== 'ESRCH') {
        try {
          proc.kill('SIGKILL');
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  }
  try {
    proc.kill('SIGKILL');
    return true;
  } catch {
    return false;
  }
}

function readJson(pathname) {
  if (!fs.existsSync(pathname)) return null;
  try {
    return JSON.parse(fs.readFileSync(pathname, 'utf8'));
  } catch {
    return null;
  }
}

function isolationBackend(requested) {
  if (!['required', 'macos-sandbox', 'process'].includes(requested)) {
    throw new TypeError('isolation must be "required", "macos-sandbox", or "process"');
  }
  if (requested === 'process') return { kind: 'process' };
  if (process.platform !== 'darwin') {
    return {
      error:
        'OS isolation is required, but this host is not macOS and no container backend is configured',
    };
  }
  const command = '/usr/bin/sandbox-exec';
  if (!fs.existsSync(command)) {
    return { error: `OS isolation is required, but ${command} is unavailable` };
  }
  return { kind: 'macos-sandbox', command };
}

function safetyRecord(backend, appliedLimits = null) {
  // A requested backend is not an applied backend. The launcher status is
  // created only after sandbox-exec has successfully entered the profile and
  // applied every rlimit, so do not claim an OS boundary before it exists.
  const osBoundary = backend?.kind === 'macos-sandbox' && appliedLimits !== null;
  return {
    backend: backend?.kind ?? 'unavailable',
    environment: 'fixed-allowlist',
    inheritedEnvironmentNames: [...INHERITED_ENV_ALLOWLIST],
    processGroup: process.platform === 'win32' ? 'single-process-only' : 'dedicated',
    resourceLimits: appliedLimits,
    osBoundary,
    networkDenied: osBoundary,
    processForkDenied: osBoundary,
    workspaceConfidential: osBoundary,
    // Same-process pytest architecture: this remains false even under Seatbelt.
    hiddenTestsConfidential: false,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.code          student code (goes to submission.py)
 * @param {string} opts.testSource    contents of the hidden test file
 * @param {string} [opts.dataDir]     optional directory copied in (e.g. acc.dat)
 * @param {string} opts.pythonPath    interpreter (the eval venv)
 * @param {number} [opts.timeoutMs]   wall clock limit, default 60 s
 * @param {object} [opts.limits]       optional lower resource limits
 * @param {string} [opts.isolation]    required (default), macos-sandbox, or process
 * @returns {Promise<object>} outcome record
 */
function runTests({
  code,
  testSource,
  dataDir,
  pythonPath,
  timeoutMs = 60_000,
  limits = {},
  isolation = 'required',
}) {
  if (typeof code !== 'string' || typeof testSource !== 'string') {
    throw new TypeError('code and testSource must be strings');
  }
  if (typeof pythonPath !== 'string' || !path.isAbsolute(pythonPath)) {
    throw new TypeError('pythonPath must be an absolute path');
  }
  const backend = isolationBackend(isolation);
  if (backend.error) {
    return Promise.resolve({
      outcome: 'harness_error',
      solved: false,
      total: 0,
      passed: 0,
      fraction: 0,
      failures: [],
      timedOut: false,
      stdout: '',
      stderr: backend.error,
      safety: safetyRecord(backend),
    });
  }
  if (dataDir !== undefined) {
    if (typeof dataDir !== 'string' || !fs.existsSync(dataDir)) {
      throw new Error(`dataDir does not exist: ${dataDir}`);
    }
    assertPlainDataTree(dataDir);
  }
  const requestedLimits = effectiveLimits(timeoutMs, limits);
  const realPython = fs.realpathSync(pythonPath);
  const pythonExec = pythonExecutionPath(pythonPath);
  const pyVenvLauncher = pythonExec !== realPython ? pythonPath : null;
  const venvRoot = path.dirname(path.dirname(pythonPath));
  // Seatbelt evaluates canonical vnode paths. On macOS os.tmpdir() commonly
  // starts with /var while the same directory resolves under /private/var;
  // rendering the alias into a subpath rule makes legitimate task reads fail.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cellmate-eval-')));
  const reportPath = path.join(dir, 'report.json');
  const limitStatusPath = path.join(dir, 'limits-applied.json');
  const launcherPath = path.join(dir, 'resource_launcher.py');
  const profilePath = path.join(dir, 'sandbox.sb');
  fs.writeFileSync(path.join(dir, 'submission.py'), code, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'test_hidden.py'), testSource, { encoding: 'utf8', mode: 0o400 });
  fs.writeFileSync(path.join(dir, 'conftest.py'), CONFTEST, { encoding: 'utf8', mode: 0o400 });
  fs.writeFileSync(launcherPath, RESOURCE_LAUNCHER, { encoding: 'utf8', mode: 0o400 });
  if (backend.kind === 'macos-sandbox') {
    const profile = macosSandboxProfile({
      taskDir: dir,
      venvRoot,
      pythonPath,
      realPython,
      pythonExec,
    });
    fs.writeFileSync(profilePath, profile, { encoding: 'utf8', mode: 0o400 });
  }
  if (dataDir) {
    fs.cpSync(dataDir, path.join(dir, path.basename(dataDir)), { recursive: true });
  }

  return new Promise((resolve) => {
    const pytestArgs = [
      '-m',
      'pytest',
      '-p',
      'pytest_jsonreport.plugin',
      '-p',
      'no:cacheprovider',
      '--capture=tee-sys',
      'test_hidden.py',
      '--json-report',
      `--json-report-file=${reportPath}`,
      '-q',
    ];
    const pythonCommand = [
      pythonExec,
      [
        launcherPath,
        JSON.stringify(requestedLimits),
        limitStatusPath,
        pythonExec,
        pythonPath,
        ...pytestArgs,
      ],
    ];
    let [command, commandArgs] = pythonCommand;
    if (backend.kind === 'macos-sandbox') {
      command = backend.command;
      commandArgs = [
        '-f',
        profilePath,
        pythonExec,
        ...pythonCommand[1],
      ];
    }
    const proc = cp.spawn(
      command,
      commandArgs,
      {
        cwd: dir,
        env: childEnvironment(dir, pyVenvLauncher),
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let stdout = '';
    let stderr = '';
    let capturedBytes = 0;
    let finished = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let timer = null;

    const cleanAndResolve = (result) => {
      terminateProcessGroup(proc);
      fs.rmSync(dir, { recursive: true, force: true });
      resolve(result);
    };

    // A missing or broken interpreter must surface as a result, not as an
    // unhandled event that takes the whole batch down mid-run.
    proc.on('error', (err) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      cleanAndResolve({
        outcome: 'harness_error',
        solved: false,
        total: 0,
        passed: 0,
        fraction: 0,
        failures: [],
        timedOut: false,
        stdout: '',
        stderr: `could not run python (${err.code ?? err.message}): ${pythonPath}`,
        safety: safetyRecord(backend),
      });
    });

    timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      terminateProcessGroup(proc);
    }, timeoutMs);

    const capture = (streamName, data) => {
      if (outputLimitExceeded) return;
      capturedBytes += data.length;
      const remaining = Math.max(0, requestedLimits.outputBytes - Buffer.byteLength(stdout) - Buffer.byteLength(stderr));
      const text = data.subarray(0, remaining).toString();
      if (streamName === 'stdout') stdout += text;
      else stderr += text;
      if (capturedBytes > requestedLimits.outputBytes) {
        outputLimitExceeded = true;
        terminateProcessGroup(proc);
      }
    };
    proc.stdout.on('data', (d) => capture('stdout', d));
    proc.stderr.on('data', (d) => capture('stderr', d));

    proc.on('close', (exitCode, signal) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);

      // The group may still contain descendants after pytest exits. Killing it
      // again is essential; killing only proc would leave ordinary children.
      terminateProcessGroup(proc);

      const report = readJson(reportPath);
      const appliedLimits = readJson(limitStatusPath);

      if (appliedLimits === null) {
        cleanAndResolve({
          outcome: 'harness_error',
          solved: false,
          total: 0,
          passed: 0,
          fraction: 0,
          failures: [],
          timedOut,
          stdout,
          stderr: stderr || 'resource limits were not applied',
          exitCode,
          signal,
          pytestReport: report,
          safety: safetyRecord(backend),
        });
        return;
      }

      const tests = report?.tests ?? [];
      const total = tests.length;
      const passed = tests.filter((t) => t.outcome === 'passed').length;
      const failures = tests
        .filter((t) => t.outcome !== 'passed')
        .map((t) => ({
          name: String(t.nodeid).split('::').pop(),
          message: firstFailureLine(t),
        }));

      // A crash in the student's demonstration code is recorded, not fatal:
      // the definitions above it were still graded.
      const crashPath = path.join(dir, 'driver_crash.txt');
      let driverCrash = null;
      if (fs.existsSync(crashPath)) {
        driverCrash = fs.readFileSync(crashPath, 'utf8').trim();
      }

      // Outcome classes are kept separate on purpose: "wrote nothing runnable"
      // is novice behaviour worth counting, but it must not be blurred into a
      // 0% pass rate for code that ran and simply failed.
      let outcome;
      if (timedOut) outcome = 'timeout';
      else if (outputLimitExceeded || ['SIGXCPU', 'SIGXFSZ', 'SIGKILL'].includes(signal)) {
        outcome = 'resource_limit';
      }
      else if (total === 0) outcome = 'error'; // nothing collected: syntax error, or the tested name never existed
      else if (passed === total) outcome = 'pass';
      else if (passed === 0) outcome = 'fail';
      else outcome = 'partial';

      cleanAndResolve({
        outcome,
        solved: outcome === 'pass',
        total,
        passed,
        fraction: total > 0 ? passed / total : 0,
        failures: failures.slice(0, 3),
        timedOut,
        outputLimitExceeded,
        driverCrash: driverCrash !== null,
        driverCrashTail: driverCrash === null
          ? null
          : driverCrash.split('\n').slice(-3).join('\n'),
        driverCrashTrace: driverCrash,
        // Output is already bounded by requestedLimits.outputBytes. Preserve
        // every captured byte in the raw grader record; presentation layers
        // may derive shorter tails without destroying audit evidence.
        stdout,
        stderr,
        exitCode,
        signal,
        pytestReport: report,
        safety: safetyRecord(backend, appliedLimits),
      });
    });
  });
}

/** Student-visible feedback for the next round: counts plus the first problem. */
function feedbackForStudent(result) {
  if (result.outcome === 'timeout') {
    return 'Your code did not finish running - it may contain a loop that never ends.';
  }
  if (result.outcome === 'resource_limit') {
    return 'Your code exceeded the evaluation resource or output limit.';
  }
  if (result.outcome === 'harness_error') {
    return 'The evaluation harness could not run your code; this attempt should be retried.';
  }
  if (result.outcome === 'error') {
    const line = (result.stderr || result.stdout).split('\n').filter(Boolean).pop() ?? '';
    return `Your code could not be run. The tool reported: ${line.slice(0, 200)}`;
  }
  const head = `${result.passed} of ${result.total} checks passed.`;
  if (result.failures.length === 0) return head;
  return `${head} First problem: ${result.failures[0].message}`;
}

// The trusted-grader prototype reuses the exact same launcher/profile/runtime
// primitives so isolation claims cannot drift between two implementations.
// These are infrastructure helpers, not a second public grading API.
const SANDBOX_RUNTIME = Object.freeze({
  RESOURCE_LAUNCHER,
  assertPlainDataTree,
  childEnvironment,
  effectiveLimits,
  isolationBackend,
  macosSandboxProfile,
  pythonExecutionPath,
  readJson,
  safetyRecord,
  terminateProcessGroup,
});

module.exports = { LIMIT_CAPS, SANDBOX_RUNTIME, runTests, feedbackForStudent };

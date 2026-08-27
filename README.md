# CellMate Guide Mode

CellMate is a VS Code extension for Jupyter notebooks. It provides generated
step guides, progress checks, error assistance, AI feedback, feedback
expansion, speech-to-text, and telemetry export.

## Repository structure

```text
cellmate_ec/
├── src/                    VS Code extension source
│   ├── extension.ts        extension activation, commands, and notebook UI
│   ├── decompose.ts        StepGuide prompt filling, parsing, and validation
│   ├── guidePanel.ts       StepGuide webview and progress display
│   ├── stepCheck.ts        done/issue/missing progress checks
│   ├── schema.ts           StepGuide data types and validation rules
│   ├── intentMarkup.ts     safe Markdown and maths rendering for step intents
│   ├── promptUtils.ts      notebook prompt-marker extraction
│   ├── gitUtils.ts         prompt/test repository synchronisation
│   ├── testUtils.ts        exercise-test execution helpers
│   ├── telemetry.ts        guide telemetry collection and export
│   └── ...                 feedback, chat, speech, and local-server modules
├── prompts/
│   ├── decompose.txt       bundled StepGuide-generation prompt
│   └── progress_check.txt  bundled progress-check prompt
├── test/                   Node tests for guide parsing, intent rendering, and progress checks
├── .vscode/launch.json     Extension Development Host launch configuration
├── .github/workflows/      clean-checkout verification and VSIX release workflows
├── .vscodeignore           VSIX inclusion and secret-exclusion rules
├── eval/
│   ├── evaluation1/        guide-generation quality experiments
│   │   ├── tasks/          task text, controls, generated guides, and tests
│   │   ├── runs/           accepted formal results and frozen protocols
│   │   ├── runtime/        student-session and grading runtime
│   │   ├── code_leakage_test/  generated-guide leakage audit
│   │   └── package-lock.json   frozen Evaluation 1 Node dependencies
│   └── evaluation2/        guide/plain and note/no-note experiments
│       ├── src/tasks/      active tasks, guides, tests, and protocols
│       ├── src/lib/        model, extraction, sandbox, and grading code
│       └── runs/           accepted formal results and provenance files
├── package.json            extension metadata, settings, commands, and scripts
├── package-lock.json       root dependency lock
├── tsconfig.json           TypeScript compiler configuration
└── LICENSE                 project licence
```

Detailed experiment instructions are in
[`eval/evaluation1/README.md`](eval/evaluation1/README.md) and
[`eval/evaluation2/README.md`](eval/evaluation2/README.md).

## Requirements

- To use a packaged extension: VS Code 1.75 or later, the VS Code Python and
  Jupyter extensions, and an LLM endpoint with an API key. Node.js is not
  required.
- To run or build from source: Node.js 20 or later and npm, in addition to the
  requirements above.
- To reproduce the evaluations: Python 3.14 and the locked requirements in the
  relevant evaluation directory.

## Install a packaged VSIX

Download the VSIX matching the target machine from the repository's
[GitHub Releases](https://github.com/ada-ec825/cellmate_ec/releases):

| Target machine | VSIX target |
|---|---|
| Apple Silicon macOS | `darwin-arm64` |
| 64-bit Linux | `linux-x64` |
| 64-bit Windows | `win32-x64` |

Intel macOS, ARM Linux, and ARM Windows packages are not currently built.
VSIX files are target-specific because the speech dependency contains a native
binary.

In VS Code:

1. Open the Extensions view.
2. Open the `...` menu and select **Install from VSIX...**.
3. Select the downloaded VSIX and reload VS Code when prompted.

The same installation can be performed from a terminal with the VS Code CLI:

```bash
code --install-extension /path/to/cellmate-<version>-<target>.vsix
```

After installation, install or enable the VS Code Python and Jupyter
extensions, open a notebook, and configure the CellMate settings described
below.

## Install and run from source

```bash
git clone https://github.com/ada-ec825/cellmate_ec.git
cd cellmate_ec
npm ci
npm run compile
```

Open the repository in VS Code and press `F5`. The tracked
`.vscode/launch.json` starts an Extension Development Host using the compiled
`out/extension.js` entry point.

Configure the following settings in the VS Code window where CellMate is
running. For source development, this is the Extension Development Host:

```json
{
  "CellMate.apiUrl": "https://chat.ese.ic.ac.uk/ollama/api/generate",
  "CellMate.apiKey": "YOUR_API_KEY",
  "CellMate.modelName": "YOUR_MODEL_NAME"
}
```

The extension also accepts an Ollama-compatible endpoint. The main settings
are:

| Setting | Default | Use |
|---|---|---|
| `CellMate.apiUrl` | none | LLM request endpoint |
| `CellMate.apiKey` | none | bearer token for the endpoint |
| `CellMate.modelName` | `gpt-oss:120b` | model identifier |
| `CellMate.templateId` | `standard_feedback` | AI-feedback prompt template |
| `CellMate.useHiddenTests` | `true` | include exercise-test results in feedback |
| `CellMate.errorHelperOutput` | `markdown` | write Error Helper output to a markdown cell or cell output |
| `CellMate.errorHelper.alwaysShow` | `false` | show Error Helper without a detected error |
| `CellMate.feedbackMode` | `Expand` | use Expand or Explain on feedback markdown |
| `CellMate.showButtonInAllMarkdown` | `false` | show Expand/Explain on all markdown cells |
| `CellMate.speechProvider` | `local` | select local, OpenAI, or Azure speech-to-text |

## Use Guide Mode

Add a problem description to a markdown cell:

```markdown
<!-- prompt:problem_description -->
Write a function that returns a sorted copy of a list.
```

Add an exercise ID to the target code cell:

```python
# EXERCISE_ID: insertion_sort
```

Then:

1. Select the code cell.
2. Click **Guide** in the cell status bar, or run **Start Guide - Break the
   exercise into steps** from the Command Palette.
3. Implement the task while moving through the displayed steps.
4. Click **Check my progress** to classify each step as `done`, `issue`, or
   `missing`.
5. Use **Regenerate** to request a new guide for the same exercise.

The extension first checks the synced prompt repository for `decompose.txt`
and `progress_check.txt`, then falls back to the copies in `prompts/`.

## Use the other extension commands

Open the Command Palette to run:

- **Error Helper - Get help with cell errors**
- **Start Error Helper Chat**
- **Send Notebook Cell to AI Feedback**
- **Expand or Explain Feedback Markdown**
- **Ask Follow-up Question (via Button)**
- **Toggle Speech-to-Text Recording**
- **Export CellMate Telemetry**
- **Sync GitHub Repository**
- **List Available Templates** and **List Available Exercises**

Problem text can also be marked in a code cell:

```python
# prompt:problem_description
# Describe the task here.
```

Multi-cell prompt sections use matching markers:

```markdown
<!-- prompt:problem_description:start -->
First part of the task.
```

```markdown
Second part of the task.
<!-- prompt:problem_description:end -->
```

## Build, test, and package the extension

```bash
npm ci
npm run verify
```

`npm run verify` compiles the extension, runs all Node tests, and verifies the
hashes and row counts of the retained evaluation results. Build a
target-specific VSIX because the speech dependency includes a platform binary.
For example, on Apple Silicon:

```bash
npm run package:vsix -- --target darwin-arm64 --out cellmate-darwin-arm64.vsix
```

GitHub Actions repeats verification from a clean checkout. Tagged releases
build separate `linux-x64`, `darwin-arm64`, and `win32-x64` VSIX files.

## Run Evaluation 1

From the repository root:

```bash
npm ci --prefix eval/evaluation1
python3.14 -m venv eval/evaluation1/.venv
eval/evaluation1/.venv/bin/python -m pip install -r eval/evaluation1/requirements.txt
npm run compile
export OPENAI_API_KEY=YOUR_API_KEY
```

Validate a frozen presentation without making model calls:

```bash
node eval/evaluation1/run_experiment.js \
  --task normal \
  --presentations eval/evaluation1/tasks/normal/presentations_formal_50x2.json \
  --preflight-only
```

Run the three formal guide-quality presentation sets:

```bash
node eval/evaluation1/run_experiment.js \
  --task normal \
  --presentations eval/evaluation1/tasks/normal/presentations_formal_50x2.json \
  --seeds 78001,78002,78003,78004,78005,78006,78007,78008,78009,78010,78011,78012,78013,78014,78015,78016,78017,78018,78019,78020 \
  --run-id reproduce-normal --concurrency 8

node eval/evaluation1/run_experiment.js \
  --task simple \
  --presentations eval/evaluation1/tasks/simple/presentations_formal_25x2.json \
  --seeds 80001,80002,80003,80004,80005,80006,80007,80008,80009,80010 \
  --run-id reproduce-simple --concurrency 8

node eval/evaluation1/run_experiment.js \
  --task hard \
  --presentations eval/evaluation1/tasks/hard/presentations_formal_25x2.json \
  --seeds 80001,80002,80003,80004,80005,80006,80007,80008,80009,80010 \
  --run-id reproduce-hard --concurrency 8
```

Run the leakage-audit preflight and audit with:

```bash
node eval/evaluation1/code_leakage_test/judge.js --preflight-only
node eval/evaluation1/code_leakage_test/judge.js --concurrency 8
```

## Run Evaluation 2

Install its isolated dependency set:

```bash
cd eval/evaluation2/src
npm ci
python3.14 -m venv .venv
.venv/bin/python -m pip install -r ../requirements.txt
export OPENAI_API_KEY=YOUR_API_KEY
```

Validate the retained task protocols:

```bash
node run_formal_note_comparison.js \
  --protocol tasks/simple/protocol.best-luna6-note-vs-no-note.json \
  --preflight-only

node run_formal_note_comparison.js \
  --protocol tasks/normal/protocol.luna28-note-vs-no-note.json \
  --preflight-only

node run_formal_note_comparison.js \
  --protocol tasks/hard/protocol.best-luna6-note-vs-no-note.json \
  --preflight-only
```

For a new replication, copy the relevant protocol, set a new
`formalRun.requiredRunId`, and pass the same value with `--run-id`.

For example, after copying the Normal protocol to
`tasks/normal/protocol.replication.json` and setting its
`formalRun.requiredRunId` to `reproduce-normal-2`, run:

```bash
node run_formal_note_comparison.js \
  --protocol tasks/normal/protocol.replication.json \
  --run-id reproduce-normal-2 \
  --concurrency 8
```

## Licence

See [`LICENSE`](LICENSE).

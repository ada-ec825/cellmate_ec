# CellMate GuideMode

A VS Code extension that helps students work through Jupyter notebook
programming exercises — without handing them the answer.

CellMate GuideMode extends [CellMate](https://github.com/teachnology/cellmate),
a departmental teaching extension, with a guide mode: it turns a wall of
exercise text into an ordered plan the student can actually start from.

Everything CellMate already did is still here — it runs the teacher's hidden
tests, explains errors, and writes feedback on a cell — and the guide is built
on top of it. The name is a label for this work, not a separate product: the
commands, settings and prompt repository remain CellMate's.

---

## Why the plan matters

Watch a novice long enough and you see two kinds of stuck. One is stuck
*inside* an exercise: a bug, a wrong loop bound. Any tutor can unstick that.
The other kind never starts. The exercise sits there as one solid block of
text; the student reads it, opens the file, closes it, and twenty minutes
later nothing has been written.

That second kind usually gets blamed on the coding. It often begins earlier,
at the reading. A long specification asks you to hold every rule in mind at
once before writing a single line, and for a student with an ADHD-type
executive-function profile that is the expensive part.

**Guide mode** rewrites the same specification as a sequence of steps, each
carrying the rules that govern it. Nothing is added and nothing is removed —
only the arrangement changes. That the arrangement alone changes what a reader
builds is what the experiments in [`eval/`](#research) set out to measure.

---

## Features

### 🧭 Guide mode — the exercise as a plan

Click **🧭 Guide** on a cell tagged with an exercise id.

- The exercise is broken into **3–8 steps**, each stating what the code must
  do — never how to write it.
- **All steps stay visible.** "Five steps, I am on step two" is a fact you can
  look at, not something to hold in your head.
- Each step carries a **share of your time**, so step one does not eat the
  whole evening.
- **Progress check** reads your live code against the plan and marks every
  step *done*, *issue* or *missing*, with a short note naming the symptom —
  never the fix.
- **Nothing is gated.** Come back after an interruption and just look. A wrong
  verdict costs you a sentence, not a blocked path.
- **The system never emits code**, however hard you press it, and correctness
  is always decided by the hidden test suite rather than by any model.

### 🆘 Error Helper and Error Chat

Analyses a Python error in the cell and gives targeted debugging guidance
without giving away the answer, then lets you ask follow-up questions.

### 🧠 AI Feedback

Generates written feedback on a cell from the student's code plus hidden-test
results, using a teacher-authored prompt template.

> **Note:** the cell button for this was hidden.
> (**Send Notebook Cell to AI Feedback**) on exercises that do have tests.

### 📖 Expand / Explain and follow-up chat

Expands or explains a feedback markdown cell, with a follow-up chat button.

### 🎙️ Speech to text

Dictate into markdown cells; local, OpenAI or Azure providers.

### 📊 Telemetry

Every help request, state change and progress check becomes a versioned,
anonymised event — no code, nothing identifying, a random per-session id.
**Export CellMate Telemetry** writes a self-describing JSON envelope.

---

## Install

CellMate is on the VS Code Marketplace. To run this fork from source:

```bash
git clone https://github.com/teachnology/cellmate
cd cellmate
npm install
npm run compile
```

Then press <kbd>F5</kbd> in VS Code to launch an Extension Development Host,
or package a `.vsix`.

---

## Quick start

1. Open a `.ipynb` file.
2. Tag a code cell with an exercise id, and put the problem text in a markdown
   cell above it:

   ```python
   # EXERCISE_ID: insertion_sort
   ```

   ```markdown
   <!-- prompt:problem_description -->
   Write a function `insertion_sort(values)` that returns a new sorted list.
   ```

3. Click **🧭 Guide** on the code cell. The exercise comes back as steps.
4. Write code. Click **Check progress** in the guide panel whenever you want
   to know where you stand.

---

## Configuration

Set these in VS Code settings. The first three are required.

| Setting | Default | What it does |
|---|---|---|
| `CellMate.apiUrl` | — | Chat-completions or Ollama-compatible endpoint |
| `CellMate.apiKey` | — | Bearer token for that endpoint |
| `CellMate.modelName` | `gpt-oss:120b` | Model id |
| `CellMate.templateId` | `standard_feedback` | Default feedback template |
| `CellMate.useHiddenTests` | `true` | Run the exercise's hidden tests before writing feedback |
| `CellMate.errorHelperOutput` | `markdown` | Where Error Helper writes |
| `CellMate.errorHelper.alwaysShow` | `false` | Show the Error Helper button even with no error |
| `CellMate.feedbackMode` | `Expand` | Default action on a feedback cell |
| `CellMate.showButtonInAllMarkdown` | `false` | Offer Expand/Explain on every markdown cell |
| `CellMate.speechProvider` | `local` | `local`, `openai` or `azure` |

Speech providers take their own keys under `CellMate.speechOpenai.*` and
`CellMate.speechAzure.*`.

### Where prompts come from

Two templates ship inside the extension: `prompts/decompose.txt` (guide
generation) and `prompts/progress_check.txt`. Everything else lives in the
teacher-owned prompt repository, which syncs to a local clone.

Lookup order is **repository first, bundled second**. A teacher who publishes
`decompose.txt` to the repository overrides the shipped copy without a
software release; if they have not, the bundled one is used. Nothing is ever
written into the clone, so a repository re-sync cannot remove a template.

---
## Error Helper in detail

- **Error Helper**: Automatically analyzes Python errors and provides targeted debugging guidance without giving away answers. 

  When problem description is provided, considers both the error and problem requirements. To include problem just simply mark your problem description:

  ```markdown
  <!-- prompt:problem_description -->
  Calculate the nth Fibonacci number recursively
  ```
  Or in code cells:
  ```python
  # prompt:problem_description
  # Calculate the nth Fibonacci number recursively
  ```

- **Error Chat**: Students can ask follow-up questions about errors in a conversational interface after Error Helper's complete analysis.

#### How to Use Error Helper:
1. **Run Your Code**: Execute a Python cell that produces an error.
2. **Click Error Helper Button**: The 🆘 Error Helper button appears when errors are detected. Or set the button to always show in code cell.
3. **View Analysis**: Get structured feedback including: "What Happened", "Why It Occurred", "How to Fix It", "General Example", "Prevention Tip". Analysis can be displayed as cell output or markdown cell.

#### How to Use Error Chat:
1. **After Error Analysis**: When Error Helper completes, click "Start Chat" in the popup.
2. **Or Use Command Palette**: Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux) → "Start Error Helper Chat".
3. **Ask Questions**: Type your questions in the chat panel.
4. **Get Targeted Help**: Receive feedback based on your error context.

### Expand/Explain and Follow-up Chat

Cellmate provides additional interactive AI tools to help you better understand or refine your work.

#### Expand/Explain Button
- This button can be configured to appear **only in feedback Markdown cells** or **in all Markdown cells**.
- You can select the working mode in VS Code settings:
  - **Expand Mode**: Expand the summary of feedback with more detail, examples, or deeper reasoning.
  - **Explain Mode**: Explains and clarifies selected text or sentence.
    - In Explain Mode, select a portion of text in a Markdown cell and click the **Explain** button.
    - A new *Explanation* Markdown cell will be inserted below, containing the explanation of the selected text.

#### Ask Follow-up Button
- **Where it appears**: In *Explanation* Markdown cells.
- **What it does**: Opens a Webview panel where you can ask the AI a follow-up question.
- **How to use**:
  1. Click **Ask Follow-up**.
  2. Type your question in the Webview panel.
  3. The AI will respond in real-time.
> **Note**: Each follow-up is independent. The AI only uses the Explanation cell, your question, and the original feedback for context.  
> **Future Work**: Multi-turn conversation support inside the Webview panel.

---

## 📝 Prompt Placeholder Usage Guide
Cellmate provides a powerful prompt template system that supports various types of placeholders for dynamic content filling.

### 1. Basic Placeholders
#### Simple Text Placeholders
```markdown
<!-- prompt:problem_description -->
This is an exercise to calculate the number of digits
```
This will replace the {{problem_description}} in the prompt template if it exists.

#### Hash Comment Format
```python
# prompt: expected_output
The function should return the number of digits in the input number
```
This will replace the {{expected_output}} in the prompt template if it exists.

### 2. Multi-block Region Placeholders

For long content or multi-cell content, you can use start and end markers:

```markdown
<!-- prompt:detailed_instructions:start -->
Please read the following instructions carefully:
```

```markdown
1. The function should accept an integer parameter
2. Return the number of digits in the integer
3. Pay attention to handling negative numbers
<!-- prompt:detailed_instructions:end -->
```
This will use the two cell contents to replace the {{detailed_instructions}} in the prompt template if it exists.

### 3. Cell Reference Placeholders
#### Absolute References
- `{{cell:1}}` - Reference content of the 1st cell
- `{{cell:2:md}}` - Reference content of the 2nd Markdown cell
- `{{cell:3:cd}}` - Reference content of the 3rd code cell
#### Relative References
- `{{cell:-1}}` - Reference the previous cell from current cell
- `{{cell:+1}}` - Reference the next cell from current cell
- `{{cell:-2:md}}` - Reference the 2nd Markdown cell before current cell
- `{{cell:+3:cd}}` - Reference the 3rd code cell after current cell

### 4. Usage Examples
#### Prompt Template Example
```markdown
## Problem Description
{{problem_description}}

## Your Code
{{cell}}

## Test Results
{{test_results}}

## Feedback
{{feedback}}

## Improvement Suggestions
{{suggestions}}

## Reference Example
{{cell:1:md}}
```

#### Usage in Notebook
```python
# In code cell
# PROMPT_ID: prompt name in the prompt repo
# EXERCISE_ID: hidden test name in the test repo
def num_digits(n):
    return len(str(n))
```

```markdown
<!-- prompt:problem_description -->
Write a function to calculate the number of digits in a given integer. For example, 123 has 3 digits.
```

### 5. Placeholder Processing Rules
1. Only placeholders declared in the notebook will be processed
2. Cell reference placeholders will match cells of the specified type
3. Multiple blocks with the same key will be automatically concatenated
4. Placeholders not found will be replaced with empty strings

---

## Project structure

```text
src/
  extension.ts        commands, notebook UI, LLM transport
  decompose.ts        guide generation: prompt, JSON repair, validation, retry
  schema.ts           frozen data shapes and every structural rule
  guidePanel.ts       the guide webview
  stepCheck.ts        progress check against the plan
  intentMarkup.ts     step markup and LaTeX-to-Unicode rendering
  state.ts            per-exercise help state
  telemetry.ts        anonymised events and export
  promptUtils.ts      placeholder scanning and template filling
  testUtils.ts        hidden-test execution and parsing
  gitUtils.ts         prompt repository sync and template lookup
  configParser.ts     settings, including speech providers
  apiCaller.ts        speech transcription clients
  speech.ts  localServer.ts  ffmpegRecorder.ts  templateUtils.ts

prompts/              templates shipped with the extension
test/                 unit tests (node:test, no framework)
eval/                 research experiments (see below)
```

---

## Research

This fork is also a dissertation project, and the experiments that justify its
design live in `eval/`. Each carries its own README with the current results,
the frozen protocol and the commands to reproduce it; the numbers are kept
there rather than here so they cannot go stale in two places at once.

| | Question | Design |
|---|---|---|
| [`eval/evaluation1`](eval/evaluation1) | Can the system generate a *good* guide? | Many independently generated guides set against the same specification shown in source order, scored by what a reader builds from each. Source-order controls are run at two different part counts so that the number of reading rounds cannot explain a difference |
| [`eval/evaluation1/code_leakage_test`](eval/evaluation1/code_leakage_test) | Do the best-scoring guides give the answer away? | A worst-case audit of the highest-scoring guides, with anchors mixed in unlabelled. It exists because evaluation 1's own metric is confounded with leakage: a guide carrying the solution would score *better* |
| [`eval/evaluation2`](eval/evaluation2) | Does a good guide still help a reader who cannot rely on their own notes? | One fixed guide against source-order parts, across three specifications of increasing difficulty, crossed with a factor that clears the reader's short note at random between rounds |

Both reading experiments feed the material one part at a time. A transformer
attends to its whole input at once, which is the mechanism it is named for,
and a human reader does not: give a model the full document and the comparison
measures nothing, because every arrangement is equally available to it. So each
round shows one part and nothing else, and the only thing crossing a round
boundary is a short note the reader writes — a small, lossy stand-in for what
a person carries out of a page they have finished. A hidden test suite the
reader never sees decides the score.

These measure how an LLM agent handles organised versus unorganised
information. They are **not** measurements of people, and support no clinical
claim about ADHD or any other profile.

---

## Development

```bash
npm run compile      # tsc
npm run test:node    # 68 unit tests, no test framework
npm run verify       # compile + unit tests + evaluation analysis
```

The unit tests cover JSON extraction and repair, schema validation, markup
rendering, template filling, and both engines against scripted fake models.
Several of the parsing rules exist because a real model broke on them; the
tests are there so those rules cannot regress quietly.

---

## Contributing

Issues and pull requests welcome.

## Licence

See `LICENSE`.

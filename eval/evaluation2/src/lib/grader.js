'use strict';

const fs = require('fs');
const path = require('path');
const { runTests } = require('./sandbox.js');

const PYTHON = [
  process.env.CELLMATE_EVAL_PYTHON,
  path.join(__dirname, '..', '.venv', 'bin', 'python'),
  path.join(__dirname, '..', '..', '..', '.venv', 'bin', 'python'),
].find((candidate) => candidate && fs.existsSync(candidate)) ?? 'python3';

async function grade(code, testSource) {
  if (!code) {
    return {
      outcome: 'no_code', passed: 0, total: 0, fraction: 0,
      failures: [], driverCrash: false, pytestReport: null,
    };
  }
  return runTests({ code, testSource, pythonPath: PYTHON, timeoutMs: 90_000, isolation: 'process' });
}

async function evaluateAssertions(code, assertions, functionNames) {
  if (!Array.isArray(assertions) || assertions.length === 0) return [];
  const checks = assertions.slice(0, 3).map((item) => String(item).trim().slice(0, 240));
  const allowed = JSON.stringify(functionNames);
  const source = `import ast
import pytest
import submission

CHECKS = ${JSON.stringify(checks)}
ALLOWED_FUNCTIONS = set(${allowed})

def _literal(node):
    if isinstance(node, ast.Constant):
        return
    if isinstance(node, (ast.List, ast.Tuple)):
        for item in node.elts:
            _literal(item)
        return
    if isinstance(node, ast.Dict):
        for item in node.keys + node.values:
            _literal(item)
        return
    raise ValueError("INVALID_CHECK: only literal arguments and expected values are allowed")

def _validated(source):
    try:
        tree = ast.parse(source, mode="exec")
    except SyntaxError as exc:
        raise ValueError("INVALID_CHECK: invalid Python assertion") from exc
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.Assert):
        raise ValueError("INVALID_CHECK: write exactly one assert statement")
    comparison = tree.body[0].test
    if not isinstance(comparison, ast.Compare) or len(comparison.ops) != 1 or len(comparison.comparators) != 1:
        raise ValueError("INVALID_CHECK: use one comparison")
    if not isinstance(comparison.ops[0], (ast.Eq, ast.NotEq, ast.Is, ast.IsNot)):
        raise ValueError("INVALID_CHECK: use ==, !=, is, or is not")
    call = comparison.left
    if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name) or call.func.id not in ALLOWED_FUNCTIONS:
        raise ValueError("INVALID_CHECK: call one public task function")
    if call.keywords:
        raise ValueError("INVALID_CHECK: keyword arguments are not allowed")
    for item in call.args:
        _literal(item)
    _literal(comparison.comparators[0])
    return tree

@pytest.mark.parametrize("index", range(len(CHECKS)))
def test_observation(index):
    tree = _validated(CHECKS[index])
    namespace = {name: getattr(submission, name) for name in ALLOWED_FUNCTIONS}
    exec(compile(tree, "<student-check>", "exec"), {"__builtins__": {}}, namespace)
`;
  const result = await runTests({
    code, testSource: source, pythonPath: PYTHON, timeoutMs: 10_000, isolation: 'process',
  });
  const tests = result.pytestReport?.tests ?? [];
  return checks.map((assertion, index) => {
    const test = tests[index];
    if (!test) return { assertion, result: 'INVALID' };
    if (test.outcome === 'passed') return { assertion, result: 'OBSERVED_PASS' };
    const phase = [test.call, test.setup, test.teardown].find((value) => value?.outcome === 'failed') ?? test.call;
    const detail = String(phase?.longrepr ?? phase?.crash?.message ?? '');
    return { assertion, result: detail.includes('INVALID_CHECK:') ? 'INVALID' : 'OBSERVED_FAIL' };
  });
}

function testNames(result) {
  return (result.pytestReport?.tests ?? [])
    .map((item) => String(item.nodeid ?? '').split('::').at(-1));
}

module.exports = { evaluateAssertions, grade, testNames };

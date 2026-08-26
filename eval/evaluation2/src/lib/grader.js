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

async function gradeLogical(code, testSource, logicalTestCount) {
  if (!Number.isSafeInteger(logicalTestCount) || logicalTestCount <= 0) {
    throw new TypeError('logicalTestCount must be a positive safe integer');
  }
  const result = await grade(code, testSource);
  if (result.total === logicalTestCount) return result;
  if (result.total === 0 && ['error', 'no_code'].includes(result.outcome)) {
    return {
      ...result,
      solved: false,
      total: logicalTestCount,
      passed: 0,
      fraction: 0,
      logicalScoreNormalization: 'uncollectable_student_code_counted_as_all_logical_tests_failed',
    };
  }
  return result;
}

async function evaluateAssertions(code, assertions, functionNames) {
  if (!Array.isArray(assertions) || assertions.length === 0) return [];
  const checks = assertions.slice(0, 3).map((item) => String(item).trim());
  const allowed = JSON.stringify(functionNames);
  const source = `import ast
import pytest
import submission
from datetime import date, datetime, timedelta
from decimal import Decimal

CHECKS = ${JSON.stringify(checks)}
ALLOWED_FUNCTIONS = set(${allowed})
MAX_CHECK_CHARACTERS = 1000
SAFE_CONSTRUCTORS = {
    "date": date,
    "datetime": datetime,
    "timedelta": timedelta,
    "Decimal": Decimal,
}
SAFE_CONSTRUCTOR_KEYWORDS = {
    "date": {"year", "month", "day"},
    "datetime": {"year", "month", "day", "hour", "minute", "second", "microsecond", "fold"},
    "timedelta": {"days", "seconds", "microseconds", "milliseconds", "minutes", "hours", "weeks"},
    "Decimal": set(),
}

def _literal(node):
    if isinstance(node, ast.Constant):
        return
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        value = node.operand
        if isinstance(value, ast.Constant) and isinstance(value.value, (int, float, complex)) and not isinstance(value.value, bool):
            return
        raise ValueError("INVALID_CHECK: signs are allowed only on numeric literals")
    if isinstance(node, (ast.List, ast.Tuple)):
        for item in node.elts:
            _literal(item)
        return
    if isinstance(node, ast.Dict):
        if any(item is None for item in node.keys):
            raise ValueError("INVALID_CHECK: dictionary unpacking is not allowed")
        for item in node.keys + node.values:
            _literal(item)
        return
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in SAFE_CONSTRUCTORS:
        for item in node.args:
            _literal(item)
        allowed_keywords = SAFE_CONSTRUCTOR_KEYWORDS[node.func.id]
        for keyword in node.keywords:
            if keyword.arg not in allowed_keywords:
                raise ValueError("INVALID_CHECK: unsupported constructor keyword argument")
            _literal(keyword.value)
        return
    raise ValueError("INVALID_CHECK: only bounded literal values are allowed here")

def _index(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, str)) and not isinstance(node.value, bool):
        return
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        value = node.operand
        if isinstance(value, ast.Constant) and isinstance(value.value, int) and not isinstance(value.value, bool):
            return
    raise ValueError("INVALID_CHECK: use one literal integer or string index")

def _task_value(node):
    try:
        _literal(node)
        return
    except ValueError:
        pass
    _task_result(node)

def _task_result(node):
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ALLOWED_FUNCTIONS:
        if node.keywords:
            raise ValueError("INVALID_CHECK: keyword arguments are not allowed")
        for item in node.args:
            _task_value(item)
        return
    if isinstance(node, ast.Subscript):
        _task_result(node.value)
        _index(node.slice)
        return
    raise ValueError("INVALID_CHECK: derive the observed value from public task functions only")

def _validated(source):
    if len(source) > MAX_CHECK_CHARACTERS:
        raise ValueError(f"INVALID_CHECK: maximum length is {MAX_CHECK_CHARACTERS} characters")
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
    _task_result(comparison.left)
    _literal(comparison.comparators[0])
    return tree

@pytest.mark.parametrize("index", range(len(CHECKS)))
def test_observation(index):
    tree = _validated(CHECKS[index])
    namespace = {name: getattr(submission, name) for name in ALLOWED_FUNCTIONS}
    namespace.update(SAFE_CONSTRUCTORS)
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

module.exports = { evaluateAssertions, grade, gradeLogical, testNames };

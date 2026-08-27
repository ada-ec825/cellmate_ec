'use strict';

function pytestOutcomes(result) {
  return new Map((result?.pytestReport?.tests ?? []).map((item) => [
    String(item.nodeid ?? '').split('::').at(-1),
    item.outcome,
  ]));
}

function pairedTestDefinitions(requirementMap) {
  const definitions = Object.entries(requirementMap ?? {}).map(([name, item]) => ({
    name,
    first: item?.visibleTest,
    second: item?.hiddenTest,
  }));
  if (definitions.length === 0 || definitions.some((item) =>
    typeof item.first !== 'string' || typeof item.second !== 'string')) {
    throw new Error('every logical unseen test needs two named case variants');
  }
  if (new Set(definitions.map((item) => item.name)).size !== definitions.length ||
      new Set(definitions.map((item) => item.first)).size !== definitions.length ||
      new Set(definitions.map((item) => item.second)).size !== definitions.length) {
    throw new Error('logical unseen test mappings must be one-to-one');
  }
  return definitions;
}

function renamedCases(source, prefix, expectedNames) {
  const found = new Set();
  const output = String(source).replace(
    /^def (test_[A-Za-z0-9_]+)(\([^\n]*\):)/gm,
    (match, name, suffix) => {
      found.add(name);
      return `def ${prefix}${name}${suffix}`;
    },
  );
  const missing = expectedNames.filter((name) => !found.has(name));
  if (missing.length > 0) throw new Error(`missing paired test functions: ${missing.join(', ')}`);
  return output;
}

function buildPairedUnseenTestSource(firstSource, secondSource, requirementMap) {
  const definitions = pairedTestDefinitions(requirementMap);
  const first = renamedCases(firstSource, 'case_a_', definitions.map((item) => item.first));
  const second = renamedCases(secondSource, 'case_b_', definitions.map((item) => item.second));
  const wrappers = definitions.map((item) => [
    `def test_${item.name}():`,
    `    case_a_${item.first}()`,
    `    case_b_${item.second}()`,
  ].join('\n')).join('\n\n');
  return `${first.trim()}\n\n${second.trim()}\n\n${wrappers}\n`;
}

function scorePairedUnseenTests(firstResult, secondResult, requirementMap) {
  const definitions = pairedTestDefinitions(requirementMap);
  const first = pytestOutcomes(firstResult);
  const second = pytestOutcomes(secondResult);
  const tests = definitions.map((item) => ({
    name: item.name,
    passed: first.get(item.first) === 'passed' && second.get(item.second) === 'passed',
    caseVariants: [
      { name: item.first, outcome: first.get(item.first) ?? 'not_collected' },
      { name: item.second, outcome: second.get(item.second) ?? 'not_collected' },
    ],
  }));
  const passed = tests.filter((item) => item.passed).length;
  return {
    passed,
    total: tests.length,
    fraction: tests.length ? passed / tests.length : 0,
    caseVariantTotal: tests.length * 2,
    tests,
  };
}

function validatePairedReference(firstResult, secondResult, requirementMap) {
  const definitions = pairedTestDefinitions(requirementMap);
  const firstNames = new Set(pytestOutcomes(firstResult).keys());
  const secondNames = new Set(pytestOutcomes(secondResult).keys());
  const mappedFirst = new Set(definitions.map((item) => item.first));
  const mappedSecond = new Set(definitions.map((item) => item.second));
  const exactCoverage = firstNames.size === mappedFirst.size && secondNames.size === mappedSecond.size &&
    [...firstNames].every((name) => mappedFirst.has(name)) &&
    [...secondNames].every((name) => mappedSecond.has(name));
  const score = scorePairedUnseenTests(firstResult, secondResult, requirementMap);
  if (!exactCoverage || score.passed !== score.total) {
    throw new Error('reference does not establish exact one-to-one coverage of logical unseen tests');
  }
  return score;
}

module.exports = {
  buildPairedUnseenTestSource,
  pairedTestDefinitions,
  pytestOutcomes,
  scorePairedUnseenTests,
  validatePairedReference,
};

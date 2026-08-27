'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { mathsToUnicode, renderIntent } = require('../out/intentMarkup.js');

// ── mathsToUnicode ─────────────────────────────────────────────────

test('transliterates the LaTeX these exercises actually contain', () => {
  assert.equal(mathsToUnicode('$t_k = k \\Delta t$'), 't_k = k Δt');
  assert.equal(
    mathsToUnicode('values $a_0, \\ldots, a_{n-1}$ here'),
    'values a_0, …, a_{n-1} here'
  );
  assert.equal(mathsToUnicode('x^2 \\le 10 and \\sqrt{2}'), 'x² ≤ 10 and √2');
});

test('unwraps display maths and drops layout-only commands', () => {
  // What the model actually emits for a trapezoidal-rule formula.
  const input = String.raw`  $$v(t_k) = \Delta t \times \left(\frac{a_0}{2} + \sum_{i=1}^{k-1} a_i\right)$$`;
  assert.equal(
    mathsToUnicode(input),
    '  v(t_k) = Δt × (a_0 / 2 + ∑_{i=1}^{k-1} a_i)'
  );
});

test('unwraps \\text and leaves nothing LaTeX behind', () => {
  assert.equal(mathsToUnicode(String.raw`\text{cents} \ge 0`), 'cents ≥ 0');
});

test('keeps the spacing an operator was written with', () => {
  // "\Delta t" is one quantity; "a \times b" is two operands and a symbol.
  assert.equal(mathsToUnicode('$\\Delta t \\times (\\frac{1}{2}a_0 + a_1)$'),
    'Δt × (1 / 2a_0 + a_1)');
});

test('never rewrites an identifier inside a code span', () => {
  const input = 'array `time_array` and `acc_array`';
  assert.equal(mathsToUnicode(input), input);
});

test('leaves every underscore alone, in prose as well as code spans', () => {
  // Subscripting them would rewrite identifiers the student has to type.
  const input = 'bare time_array and net_total in prose';
  assert.equal(mathsToUnicode(input), input);
  assert.equal(mathsToUnicode('key "net_total" must be present'), 'key "net_total" must be present');
  assert.equal(mathsToUnicode('index a_0 and t_k stay literal'), 'index a_0 and t_k stay literal');
});

test('leaves money and unknown commands untouched', () => {
  assert.equal(mathsToUnicode('the price is $12.30 in cents'), 'the price is $12.30 in cents');
  assert.equal(mathsToUnicode('unknown \\foobar{x} stays put'), 'unknown \\foobar{x} stays put');
});

// ── renderIntent ───────────────────────────────────────────────────

test('renders bullets, bold and code spans', () => {
  const html = renderIntent('Goal sentence.\n- **hard rule** here\n- returns `None`');
  assert.equal(
    html,
    '<p>Goal sentence.</p><ul><li><strong>hard rule</strong> here</li>' +
      '<li>returns <code>None</code></li></ul>'
  );
});

test('escapes markup the model wrote before adding any of its own', () => {
  const html = renderIntent('- keep <script>alert(1)</script> inert');
  assert.ok(!html.includes('<script>'), html);
  assert.ok(html.includes('&lt;script&gt;'), html);
});

test('drops blank lines rather than emitting empty paragraphs', () => {
  assert.equal(renderIntent('One.\n\n\nTwo.'), '<p>One.</p><p>Two.</p>');
});

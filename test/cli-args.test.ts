import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArguments } from '../src/cli-args.js';

test('CLI parser keeps option values out of positional arguments and preserves boolean flags', () => {
  const args = parseCliArguments(['schema', '--version', '1.0', 'schema/custom.json', '--verbose']);
  assert.equal(args.command, 'schema');
  assert.deepEqual(args.positionals, ['schema/custom.json']);
  assert.equal(args.option('version'), '1.0');
  assert.equal(args.hasFlag('verbose'), true);
});

test('CLI parser retains multiple positional paths around named options', () => {
  const args = parseCliArguments(['replay', 'case.json', 'trace.json', '--out', 'replayed.json']);
  assert.deepEqual(args.positionals, ['case.json', 'trace.json']);
  assert.equal(args.option('out'), 'replayed.json');
});

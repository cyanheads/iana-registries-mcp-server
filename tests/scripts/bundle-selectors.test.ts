/**
 * @fileoverview Bundle pruning preserves executable SDK extension code.
 * @module tests/scripts/bundle-selectors
 */
import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY as cleaner } from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY as linter } from '../../scripts/lint-packaging.js';

describe.each([
  ['cleaner', cleaner],
  ['linter', linter],
] as const)('%s agent-doc selector', (_, selector) => {
  it.each([
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.d.ts',
    'node_modules/parent/node_modules/@modelcontextprotocol/server/dist/ext/skills/load.js',
    'node_modules/other/dist/skills/runtime.js',
  ])('preserves runtime path %s', (path) => {
    expect(selector.test(path)).toBe(false);
  });
  it.each([
    'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
    'node_modules/other/skills/example/SKILL.md',
    'node_modules/parent/node_modules/other/.claude/skills/example/SKILL.md',
    'node_modules/other/.agents/skills/example/SKILL.md',
    'node_modules/other/SKILL.md',
  ])('removes package-root agent docs %s', (path) => {
    expect(selector.test(path)).toBe(true);
  });
});

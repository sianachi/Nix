import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blueprintSchema } from '../blueprint/schema.js';
import { validateBlueprint } from '../blueprint/validate.js';
import { chatCaseSchema, chatSuiteSchema } from './chat-schema.js';

describe('chat review evaluation contract', () => {
  it('keeps the dedicated fixture buildable and every suite reference local to it', () => {
    const raw = readFileSync(
      new URL('../../evals/chat/fixture.json', import.meta.url),
      'utf8',
    ).replaceAll(/\{today(?:[+-]\d+)?\}/g, '2026-10-09');
    const fixture = blueprintSchema.parse(JSON.parse(raw));
    const report = validateBlueprint(fixture, { inheritedFields: [], today: '2026-10-09' });
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    const nodes = new Set<string>();
    const collect = (node: typeof fixture.root) => {
      nodes.add(node.id);
      for (const child of node.children ?? []) collect(child);
    };
    collect(fixture.root);
    const cases = chatSuiteSchema.parse(
      JSON.parse(readFileSync(new URL('../../evals/chat/cases.json', import.meta.url), 'utf8')),
    );
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(cases.length);
    for (const entry of cases) {
      if (entry.templateSource !== undefined) expect(nodes.has(entry.templateSource)).toBe(true);
      for (const match of entry.prompt.matchAll(/\{node:([^}]+)\}/g))
        expect(nodes.has(match[1] ?? '')).toBe(true);
      for (const ref of entry.answerChecks?.references ?? []) expect(nodes.has(ref)).toBe(true);
      for (const assertion of entry.asserts) {
        if ('item' in assertion) expect(nodes.has(assertion.item)).toBe(true);
        if ('parent' in assertion) expect(nodes.has(assertion.parent)).toBe(true);
        for (const match of JSON.stringify(assertion).matchAll(/\{item:([^}]+)\}/g))
          expect(nodes.has(match[1] ?? '')).toBe(true);
      }
    }
  });

  it('rejects contradictory review approvals and malformed bounded patterns', () => {
    expect(
      chatCaseSchema.safeParse({
        id: 'review',
        prompt: 'Review',
        noWrites: true,
        approvedOperations: ['update_view'],
      }).success,
    ).toBe(false);
    for (const assertion of [
      { kind: 'child', parent: 'home', title: '[' },
      { kind: 'child', parent: 'home', title: 'Demo', noteContains: '[' },
      { kind: 'note', item: 'home', contains: '[' },
    ])
      expect(
        chatCaseSchema.safeParse({ id: 'review', prompt: 'Review', asserts: [assertion] }).success,
      ).toBe(false);
    expect(
      chatCaseSchema.safeParse({
        id: 'review',
        prompt: 'Review',
        workspaceAccess: false,
        approvedOperations: ['update_view'],
      }).success,
    ).toBe(false);
    expect(
      chatCaseSchema.safeParse({
        id: 'review',
        prompt: 'Review',
        approvedOperations: ['delete_permanently'],
      }).success,
    ).toBe(false);
    expect(
      chatCaseSchema.safeParse({ id: 'review', prompt: 'Review', answerChecks: { all: ['['] } })
        .success,
    ).toBe(false);
    expect(
      chatCaseSchema.safeParse({
        id: 'review',
        prompt: 'Review',
        feedbackChecks: [{ code: 'missing-tool', matches: '[' }],
      }).success,
    ).toBe(false);
    expect(
      chatCaseSchema.safeParse({
        id: 'review',
        prompt: 'Review',
        answerChecks: { all: Array<string>(9).fill('date') },
      }).success,
    ).toBe(false);
  });
});

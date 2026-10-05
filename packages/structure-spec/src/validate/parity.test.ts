import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { StructureProperty, StructureView } from '../types.js';
import { refuseSchema } from './schema-rules.js';
import { refuseViews } from './view-rules.js';

/**
 * `fixtures/rule-parity.json` is meant to become the one file both this suite and a C# suite (task
 * A.2, not yet written - no `StructureRuleParityTests.cs` exists in this tree) read: the same
 * schema and view shapes, run through this package's ported rules here and through
 * `PropertySchemaRules.Refuse` / `SetContainerViewsHandler.Validate` there. A case that passes here
 * and fails there, or the other way round, is exactly the drift this fixture exists to catch
 * before a pet ever meets it - for the `schema` verdict, which this package ports faithfully.
 *
 * The `views` verdict is not uniformly that kind of parity. `SetContainerViewsHandler.Validate`
 * (`ViewDefinitionRules.Refuse`) is handed no schema, so it can only check that a kind's required
 * field is present, never that it names a property of the right type - that check exists only on
 * the read path, in `ViewDefinition.CanRender`. This package applies `CanRender`'s rule at write
 * time on purpose (architecture 4 item 5), which is stricter than Core's storage-time refusal.
 * Every case's `viewsScope` says which kind of check its `views` verdict exercises: `"parity"`
 * means A.2 must assert the same verdict against `SetContainerViewsHandler.Validate`; `"client-only"`
 * means this package refuses something Core's write path accepts on purpose, and A.2 must not
 * assert a Core refusal for it (it would fail).
 */
interface RuleParityCase {
  id: string;
  schema: { properties: StructureProperty[]; inherit: boolean };
  views: StructureView[];
  default: string | null;
  expect: { schema: 'ok' | 'refused'; views: 'ok' | 'refused' };
  viewsScope: 'parity' | 'client-only';
}

interface RuleParityFixture {
  version: number;
  cases: RuleParityCase[];
}

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'rule-parity.json',
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as RuleParityFixture;

describe('rule-parity fixture', () => {
  it('carries at least 24 cases', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(24);
  });

  it('every case id is unique', () => {
    const ids = fixture.cases.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every case declares its views scope', () => {
    for (const testCase of fixture.cases) {
      expect(['parity', 'client-only']).toContain(testCase.viewsScope);
    }
  });

  for (const testCase of fixture.cases) {
    it(`${testCase.id}: schema verdict matches`, () => {
      const reason = refuseSchema(testCase.schema);
      expect(reason === null ? 'ok' : 'refused').toBe(testCase.expect.schema);
    });

    it(`${testCase.id}: views verdict matches`, () => {
      const effective = testCase.schema.properties;
      const reason = refuseViews(testCase.views, effective, testCase.default);
      expect(reason === null ? 'ok' : 'refused').toBe(testCase.expect.views);
    });
  }
});

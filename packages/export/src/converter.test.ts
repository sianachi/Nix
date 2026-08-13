import { describe, expect, it } from 'vitest';

import { createConverterRegistry, type DocumentConverter } from './converter.js';

function stubConverter(overrides: Partial<DocumentConverter> = {}): DocumentConverter {
  return {
    format: 'pdf',
    mediaType: 'application/pdf',
    extension: 'pdf',
    declaredLoss: () => [],
    convert: async function* () {
      yield await Promise.resolve(new Uint8Array([0]));
    },
    ...overrides,
  };
}

describe('the converter registry', () => {
  it('answers with null for a format this host does not have', () => {
    const registry = createConverterRegistry();

    expect(registry.get('docx')).toBeNull();
    expect(registry.get('not-a-format')).toBeNull();
  });

  it('returns the converter that was registered for a format', () => {
    const registry = createConverterRegistry();
    const converter = stubConverter();

    registry.register(converter);

    expect(registry.get('pdf')).toBe(converter);
  });

  it('lists the formats it holds, so a service can say what it can produce', () => {
    const registry = createConverterRegistry();

    registry.register(stubConverter({ format: 'pdf' }));
    registry.register(stubConverter({ format: 'docx', extension: 'docx' }));

    expect(registry.formats()).toEqual(['pdf', 'docx']);
  });

  it('refuses a second converter for one format rather than letting order decide', () => {
    const registry = createConverterRegistry();

    registry.register(stubConverter());

    expect(() => {
      registry.register(stubConverter());
    }).toThrow("A converter for 'pdf' is already registered.");
  });
});

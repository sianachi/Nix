import { describe, expect, it } from 'vitest';
import { collaborationUrl, coreRequestUrl, parseCoreOrigin } from '../../lib/core-origin';

describe('bundled mobile Core routing', () => {
  it.each(['capacitor://localhost', 'https://localhost', 'http://localhost'])(
    'routes backend requests from %s without redirecting local assets',
    (local) => {
      expect(coreRequestUrl('/api/v1/items?limit=20', local, 'https://nix.example')).toBe(
        'https://nix.example/api/v1/items?limit=20',
      );
      expect(coreRequestUrl('/auth/session', local, 'https://nix.example')).toBe(
        'https://nix.example/auth/session',
      );
      expect(coreRequestUrl('/collab/documents/note/ws', local, 'https://nix.example')).toBe(
        'https://nix.example/collab/documents/note/ws',
      );
      expect(coreRequestUrl('/assets/editor.js', local, 'https://nix.example')).toBe(
        `${local}/assets/editor.js`,
      );
    },
  );
  it('connects collaboration to Core while preserving secure absolute WebSocket URLs', () => {
    expect(collaborationUrl('/collab/documents/note/ws', 'https://nix.example')).toBe(
      'wss://nix.example/collab/documents/note/ws',
    );
    expect(collaborationUrl('/collab/documents/note/ws', 'http://localhost:5173')).toBe(
      'ws://localhost:5173/collab/documents/note/ws',
    );
    expect(collaborationUrl('wss://nix.example/collab/documents/note/ws', 'http://localhost')).toBe(
      'wss://nix.example/collab/documents/note/ws',
    );
    expect(() => collaborationUrl('file:///note')).toThrow();
  });
  it('leaves capability URLs and unrelated external hosts unchanged', () => {
    expect(
      coreRequestUrl(
        'https://files.example/object?signature=abc',
        'capacitor://localhost',
        'https://nix.example',
      ),
    ).toBe('https://files.example/object?signature=abc');
    expect(
      coreRequestUrl(
        'https://other.example/api/v1/items',
        'capacitor://localhost',
        'https://nix.example',
      ),
    ).toBe('https://other.example/api/v1/items');
  });
  it.each([
    'http://remote.example',
    'https://user:secret@nix.example',
    'https://nix.example/path',
    'https://nix.example?token=secret',
    'https://nix.example#fragment',
  ])('rejects an unsafe Core origin %s', (origin) => {
    expect(() => parseCoreOrigin(origin)).toThrow();
  });
  it('accepts HTTPS deployment origins and explicit loopback development', () => {
    expect(parseCoreOrigin('https://nix.example')).toBe('https://nix.example');
    expect(parseCoreOrigin('http://localhost:5014')).toBe('http://localhost:5014');
  });
});

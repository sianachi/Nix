import { describe, expect, it, vi } from 'vitest';

import { parseSelectedItem, selectedItemSearch } from './selected-item';

describe('the selected item parameter', () => {
  it('reads an identifier out of the URL', () => {
    expect(parseSelectedItem('1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e')).toBe(
      '1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e',
    );
  });

  it('treats an absent parameter as nothing open', () => {
    expect(parseSelectedItem(null)).toBeNull();
    expect(parseSelectedItem('')).toBeNull();
  });

  it('drops a value that is not an identifier, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // The URL is the most hostile runtime boundary there is - anybody can type into it - so a
    // malformed one leaves the shell with nothing open rather than sending nonsense to Core.
    expect(parseSelectedItem('../../etc/passwd')).toBeNull();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('builds a shareable search string', () => {
    expect(selectedItemSearch('1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e')).toBe(
      '?item=1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e',
    );
  });
});

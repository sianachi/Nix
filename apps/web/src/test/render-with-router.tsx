import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';

/**
 * Renders a tree under a MemoryRouter at a given URL.
 *
 * Tests drive the app the way a user does - through the address - so the
 * URL-state convention is exercised rather than mocked. There is no provider
 * stack beyond the router: no store, no client, nothing to keep in sync.
 */
export function renderAt(ui: ReactElement, url = '/'): RenderResult {
  return render(<MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>);
}

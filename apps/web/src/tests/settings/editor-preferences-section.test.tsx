import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useKeyboardModeStore } from '../../editor/keyboard-mode-store';
import { EditorPreferencesSection } from '../../settings/editor-preferences-section';

describe('editor preferences', () => {
  beforeEach(() => {
    useKeyboardModeStore.setState({ mode: 'standard', persistence: 'stored' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers one mutually exclusive keyboard mode and says where it is stored', () => {
    render(<EditorPreferencesSection />);

    expect(screen.getByRole('combobox', { name: 'Keyboard mode' })).toHaveValue('standard');
    expect(screen.getByText(/stored only in this browser/i)).toBeVisible();
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Standard',
      'Emacs basics',
    ]);
  });

  it('applies the choice immediately and explains its scope', async () => {
    const user = userEvent.setup();
    render(<EditorPreferencesSection />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Keyboard mode' }), 'emacs');

    expect(useKeyboardModeStore.getState().mode).toBe('emacs');
    expect(screen.getByText(/Ctrl\+A and Ctrl\+E/i)).toBeVisible();
    expect(screen.getByText(/kill\/yank are not included/i)).toBeVisible();
  });

  it('announces when a new choice cannot be remembered', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    render(<EditorPreferencesSection />);
    const status = screen.getByRole('status');
    expect(status).toBeEmptyDOMElement();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Keyboard mode' }), 'emacs');

    expect(status).toHaveTextContent(/may reset when this page reloads/i);
  });

  it('does not imply that the Standard default will be lost without storage', () => {
    useKeyboardModeStore.setState({ mode: 'standard', persistence: 'session-only' });
    render(<EditorPreferencesSection />);

    expect(screen.getByRole('status')).toHaveTextContent(/Standard remains the default/i);
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readGhostTextSetting, useGhostTextPreference } from '../../editor/ghost-text-preference';
import { useKeyboardModeStore } from '../../editor/keyboard-mode-store';
import { usePageGuidePreference } from '../../editor/page-guide-preference';
import { EditorPreferencesSection } from '../../settings/editor-preferences-section';
import {
  readChoiceOrderSetting,
  readViewSuggestionSetting,
  useChoiceOrderPreference,
  useViewSuggestionPreference,
} from '../../settings/suggestion-preferences';

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
      'Vim basics',
      'Emacs basics',
    ]);
  });

  it('states the exact boundary of Vim basics', async () => {
    const user = userEvent.setup();
    render(<EditorPreferencesSection />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Keyboard mode' }), 'vim');

    expect(screen.getByText(/h\/l move by character/i)).toBeVisible();
    expect(
      screen.getByText(/w\/b\/e move by language word within the current text block/i),
    ).toBeVisible();
    expect(screen.getByText(/Escape returns to Normal/i)).toBeVisible();
    expect(screen.getByText(/Visual mode, j\/k, operators, counts/i)).toBeVisible();
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

  it('names a session-only Vim choice accurately', () => {
    useKeyboardModeStore.setState({ mode: 'vim', persistence: 'session-only' });
    render(<EditorPreferencesSection />);

    expect(screen.getByRole('status')).toHaveTextContent(/Vim basics may reset/i);
  });
});

describe('page guides', () => {
  it('are shown by default and can be switched off', async () => {
    const user = userEvent.setup();
    usePageGuidePreference.setState({ visibility: 'shown', saved: true });
    render(<EditorPreferencesSection />);

    const toggle = screen.getByRole('checkbox', { name: 'Show page guides' });
    expect(toggle).toBeChecked();
    expect(
      screen.getByText(/where the PDF and Word exports would start a new page/i),
    ).toBeVisible();

    await user.click(toggle);

    expect(usePageGuidePreference.getState().visibility).toBe('hidden');
    expect(toggle).not.toBeChecked();
  });
});

describe('phrase suggestions', () => {
  it('are off until asked for, and say how to accept and where they learn', async () => {
    const user = userEvent.setup();
    useGhostTextPreference.setState({ setting: 'off', saved: true });
    render(<EditorPreferencesSection />);

    const toggle = screen.getByRole('checkbox', { name: 'Suggest phrase completions' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/Press Right Arrow to accept it or Escape/i)).toBeVisible();
    expect(screen.getByText(/in memory only/i)).toBeVisible();

    await user.click(toggle);

    expect(useGhostTextPreference.getState().setting).toBe('on');
    expect(toggle).toBeChecked();
  });

  it('read as off when nothing, or anything unexpected, is stored', () => {
    expect(readGhostTextSetting(undefined)).toBe('off');
    const storage = { getItem: () => 'maybe' } as unknown as Storage;
    expect(readGhostTextSetting(storage)).toBe('off');
  });
});

describe('suggestion switches', () => {
  it('turn view suggestions off and describe what they cover', async () => {
    const user = userEvent.setup();
    useViewSuggestionPreference.setState({ setting: 'on', saved: true });
    render(<EditorPreferencesSection />);

    const toggle = screen.getByRole('checkbox', { name: 'Suggestions in views' });
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/fill-series offer/i);

    await user.click(toggle);

    expect(useViewSuggestionPreference.getState().setting).toBe('off');
  });

  it('turn ordering by picks off and describe what it covers', async () => {
    const user = userEvent.setup();
    useChoiceOrderPreference.setState({ setting: 'on', saved: true });
    render(<EditorPreferencesSection />);

    const toggle = screen.getByRole('checkbox', { name: 'Order choices by what I pick most' });
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/Recent group/i);

    await user.click(toggle);

    expect(useChoiceOrderPreference.getState().setting).toBe('off');
  });

  it('describe every switch to assistive technology', () => {
    render(<EditorPreferencesSection />);

    for (const name of [
      'Hide mobile tools while writing',
      'Show page guides',
      'Suggest phrase completions',
      'Underline item names that are not linked',
    ]) {
      expect(screen.getByRole('checkbox', { name })).toHaveAccessibleDescription(/\w/);
    }
  });

  it('say that phrase completions need a keyboard', () => {
    render(<EditorPreferencesSection />);

    expect(
      screen.getByRole('checkbox', { name: 'Suggest phrase completions' }),
    ).toHaveAccessibleDescription(/Needs a keyboard\./);
  });

  it('read as on when nothing, or anything unexpected, is stored', () => {
    expect(readViewSuggestionSetting(undefined)).toBe('on');
    expect(readChoiceOrderSetting(undefined)).toBe('on');
    const storage = { getItem: () => 'maybe' } as unknown as Storage;
    expect(readViewSuggestionSetting(storage)).toBe('on');
  });
});

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PetSettingsEditor } from '../../pets/pet-settings-section';
import type { PetSettingsResponse } from '@nix/api-client';

vi.mock('../../pets/pet-avatar', () => ({ PetAvatar: () => null }));

const initial: PetSettingsResponse = {
  revision: 0,
  settings: { enabled: false, activePetId: null, motion: 'system', narration: false, profiles: [] },
};

describe('pet configuration', () => {
  it('saves an owl with an independently chosen personality', async () => {
    const save = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<PetSettingsEditor initial={initial} saving={false} onSave={save} />);
    await user.click(screen.getByRole('button', { name: 'Add pet' }));
    await user.clear(screen.getByRole('textbox', { name: 'Name' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Pip');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Personality' }), 'playful');
    expect(screen.getByRole('combobox', { name: 'Appearance' })).toHaveValue('owl');
    await user.click(screen.getByRole('button', { name: 'Save pet settings' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledOnce();
    });
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      enabled: false,
      profiles: [
        expect.objectContaining({ name: 'Pip', appearance: 'owl', personality: 'playful' }),
      ],
    });
  });

  it('duplicates with a distinct identity and clears active references when the last pet is removed', async () => {
    const save = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<PetSettingsEditor initial={initial} saving={false} onSave={save} />);
    await user.click(screen.getByRole('button', { name: 'Add pet' }));
    await user.click(screen.getByRole('button', { name: 'Duplicate pet' }));
    await user.click(screen.getByRole('button', { name: 'Save pet settings' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledOnce();
    });
    const value = save.mock.calls[0]?.[0] as PetSettingsResponse['settings'];
    expect(value.profiles).toHaveLength(2);
    expect(value.profiles[0]?.id).not.toBe(value.profiles[1]?.id);
    await user.click(screen.getByRole('button', { name: 'Remove pet from settings' }));
    await user.click(screen.getByRole('button', { name: 'Remove pet from settings' }));
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save pet settings' })).toBeDisabled();
  });

  it('does not announce success after a failed save', async () => {
    const user = userEvent.setup();
    render(
      <PetSettingsEditor initial={initial} saving={false} onSave={() => Promise.resolve(false)} />,
    );
    await user.click(screen.getByRole('button', { name: 'Add pet' }));
    await user.click(screen.getByRole('button', { name: 'Save pet settings' }));
    expect(screen.queryByText('Pet settings saved.')).not.toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeVisible();
  });

  it('keeps the selected pet and save confirmation when the server advances the revision', async () => {
    const save = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    const view = render(<PetSettingsEditor initial={initial} saving={false} onSave={save} />);
    await user.click(screen.getByRole('button', { name: 'Add pet' }));
    await user.click(screen.getByRole('button', { name: 'Duplicate pet' }));
    const selected = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Saved pet' }).value;
    await user.click(screen.getByRole('button', { name: 'Save pet settings' }));
    expect(await screen.findByText('Pet settings saved.')).toBeVisible();
    const settings = save.mock.calls[0]?.[0] as PetSettingsResponse['settings'];
    view.rerender(
      <PetSettingsEditor initial={{ revision: 1, settings }} saving={false} onSave={save} />,
    );
    expect(screen.getByRole('combobox', { name: 'Saved pet' })).toHaveValue(selected);
    expect(screen.getByText('Pet settings saved.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save pet settings' })).toBeDisabled();
  });
});

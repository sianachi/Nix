import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PetDeviceSettings } from '../../pets/pet-device-settings';

describe('pet device settings', () => {
  it('say once that they stay on this device', () => {
    render(<PetDeviceSettings inlineWriting={false} />);

    expect(screen.getAllByText('This device only')).toHaveLength(1);
    expect(screen.getByLabelText('Where the chat opens')).toBeInTheDocument();
  });
});

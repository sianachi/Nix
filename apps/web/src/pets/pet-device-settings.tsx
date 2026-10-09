import { Field, Select, Text } from '@nix/ui';
import { useState, type ReactElement } from 'react';

import {
  PET_SURFACE_OPTIONS,
  readDevicePreference,
  readPetSurface,
  writeDevicePreference,
  type PetSurface,
} from './device-preferences';

export function PetDeviceSettings(): ReactElement {
  const [placement, setPlacement] = useState(() => readDevicePreference('placement') || 'right');
  const [inlineContext, setInlineContext] = useState(
    () => readDevicePreference('inlineContext') === 'true',
  );
  const [surface, setSurface] = useState<PetSurface>(() => readPetSurface());
  return (
    <div className="flex flex-col gap-4">
      <Field label="Where the chat opens">
        {(control) => (
          <Select
            {...control}
            value={surface}
            onChange={(event) => {
              const value = PET_SURFACE_OPTIONS.find(
                (option) => option.value === event.currentTarget.value,
              )?.value;
              if (!value) return;
              setSurface(value);
              writeDevicePreference('surface', value);
            }}
          >
            {PET_SURFACE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={inlineContext}
            onChange={(event) => {
              setInlineContext(event.currentTarget.checked);
              writeDevicePreference('inlineContext', String(event.currentTarget.checked));
            }}
          />
          <Text>Send note context with inline AI on this device</Text>
        </label>
        <Text variant="note" tone="muted">
          When inline AI is enabled, also sends up to 32 KB of this note to your connected model.
          Off by default; otherwise only the command's text is sent.
        </Text>
      </div>
      <Field label="Companion position on this device">
        {(control) => (
          <Select
            {...control}
            value={placement}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setPlacement(value);
              writeDevicePreference('placement', value);
            }}
          >
            <option value="right">Bottom right</option>
            <option value="left">Bottom left</option>
          </Select>
        )}
      </Field>
    </div>
  );
}

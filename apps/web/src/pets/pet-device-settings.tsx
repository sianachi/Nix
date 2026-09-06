import { Field, Select, Text } from '@nix/ui';
import { useEffect, useState, type ReactElement } from 'react';
import { readDevicePreference, writeDevicePreference } from './device-preferences';

export function PetDeviceSettings(): ReactElement {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voice, setVoice] = useState(() => readDevicePreference('voice'));
  const [placement, setPlacement] = useState(() => readDevicePreference('placement') || 'right');
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const update = () => {
      setVoices(window.speechSynthesis.getVoices());
    };
    queueMicrotask(update);
    window.speechSynthesis.addEventListener('voiceschanged', update);
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', update);
    };
  }, []);
  return (
    <div className="flex flex-col gap-4">
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
      <Field label="Speaking voice on this device">
        {(control) => (
          <Select
            {...control}
            value={voice}
            disabled={voices.length === 0}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setVoice(value);
              writeDevicePreference('voice', value);
            }}
          >
            <option value="">System default</option>
            {voices.map((entry) => (
              <option key={entry.voiceURI} value={entry.voiceURI}>
                {entry.name} ({entry.lang})
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Text variant="note" tone="muted">
        Voices depend on your browser and device. Some voices and browser dictation use an online
        speech service. Microphone access starts only when you choose Dictate.
      </Text>
    </div>
  );
}

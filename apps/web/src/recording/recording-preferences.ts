/**
 * What this device last recorded with. A device preference, not an account one: the headset that
 * is right at a desk does not exist on the phone.
 */

const MICROPHONE = 'nix.recording.microphone';
const SHARE_AUDIO = 'nix.recording.share-audio';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // A preference that cannot be kept is asked for again next time.
  }
}

/** The chosen microphone's device id, or null for whichever one the browser picks. */
export function readPreferredMicrophone(): string | null {
  const value = read(MICROPHONE);
  return value === null || value === '' ? null : value;
}

export function writePreferredMicrophone(deviceId: string | null): void {
  write(MICROPHONE, deviceId);
}

export function readShareAudioPreference(): boolean {
  return read(SHARE_AUDIO) === 'true';
}

export function writeShareAudioPreference(share: boolean): void {
  write(SHARE_AUDIO, share ? 'true' : null);
}

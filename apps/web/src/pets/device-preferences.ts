export type PetPlacement = 'left' | 'right';
export type PetConversationMode = 'chat' | 'consult';

/** Where the chat opens: the floating panel, its own page, or both. A device preference because
 * the right answer depends on the screen in front of the owner, not on the pet. */
export type PetSurface = 'floating' | 'page-on-phones' | 'page' | 'both';

export const PET_SURFACE_DEFAULT: PetSurface = 'page-on-phones';

export const PET_SURFACE_OPTIONS: readonly {
  readonly value: PetSurface;
  readonly label: string;
}[] = [
  { value: 'floating', label: 'Floating panel everywhere' },
  { value: 'page-on-phones', label: 'Its own page on phones, floating elsewhere' },
  { value: 'page', label: 'Its own page everywhere' },
  { value: 'both', label: 'Both: floating panel, and a page in the navigation' },
];

export interface PetPosition {
  x: number;
  y: number;
}

export function readPetPosition(): PetPosition | null {
  try {
    const raw = localStorage.getItem('nix.pet.position');
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'x' in parsed &&
      'y' in parsed &&
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number' &&
      Number.isFinite(parsed.x) &&
      Number.isFinite(parsed.y)
    )
      return { x: parsed.x, y: parsed.y };
  } catch {
    /* Fall back to the edge placement when storage is unavailable or malformed. */
  }
  return null;
}

export function writePetPosition(position: PetPosition): void {
  try {
    localStorage.setItem('nix.pet.position', JSON.stringify(position));
  } catch {
    /* The current session still retains the position when storage is unavailable. */
  }
  window.dispatchEvent(new Event('nix-pet-device-changed'));
}

function conversationModelKey(
  workspaceId: string,
  petId: string,
  mode: PetConversationMode,
): string {
  return `nix.pet.model.${workspaceId}.${petId}.${mode}`;
}

export function readConversationModel(
  workspaceId: string,
  petId: string,
  mode: PetConversationMode,
): string {
  try {
    const model =
      localStorage.getItem(conversationModelKey(workspaceId, petId, mode)) ??
      (mode === 'chat' ? sessionStorage.getItem(`nix.pet.model.${workspaceId}.${petId}`) : null) ??
      '';
    return model.length <= 160 ? model : '';
  } catch {
    return '';
  }
}

export function writeConversationModel(
  workspaceId: string,
  petId: string,
  mode: PetConversationMode,
  model: string,
): void {
  try {
    localStorage.setItem(conversationModelKey(workspaceId, petId, mode), model);
  } catch {
    /* The open conversation retains the selection when storage is unavailable. */
  }
}

type DevicePreferenceKey = 'voice' | 'placement' | 'surface' | 'inlineContext';

export function readDevicePreference(key: DevicePreferenceKey): string {
  try {
    return localStorage.getItem(`nix.pet.${key}`) ?? '';
  } catch {
    return '';
  }
}

export function writeDevicePreference(key: DevicePreferenceKey, value: string): void {
  try {
    localStorage.setItem(`nix.pet.${key}`, value);
  } catch {
    /* Storage may be disabled. */
  }
  window.dispatchEvent(new Event('nix-pet-device-changed'));
}

/** The stored surface, or the default when nothing valid is stored - a value written by a
 * different build must not leave the chat with nowhere to open. */
export function readPetSurface(): PetSurface {
  const stored = readDevicePreference('surface');
  return (
    PET_SURFACE_OPTIONS.find((option) => option.value === stored)?.value ?? PET_SURFACE_DEFAULT
  );
}

/** Whether reads (and, in Design mode, checking a blueprint) run without an approval click.
 * Defaults on: with `readWithoutAsking` on (owner decision, default on, ADR-0050 amendment 1) a
 * read's result is shared with ChatGPT without a per-read click; consent is the per-message
 * workspace access toggle; reads are Core-authorised, scoped to the workspace, at most 20 per
 * turn and 16000 characters each. Device-wide, like `placement` above. */
export function readReadWithoutAsking(): boolean {
  try {
    const raw = localStorage.getItem('nix.pet.readWithoutAsking');
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

export function writeReadWithoutAsking(value: boolean): void {
  try {
    localStorage.setItem('nix.pet.readWithoutAsking', String(value));
  } catch {
    /* The open conversation still applies the choice for this session. */
  }
  window.dispatchEvent(new Event('nix-pet-device-changed'));
}

function workspaceAccessKey(workspaceId: string, petId: string): string {
  return `nix.pet.workspaceAccess.${workspaceId}.${petId}`;
}

/** Whether workspace tools are offered for the next message to this pet, on this device, in
 * this workspace. Off on first use: a device that has never granted a pet workspace access
 * should not silently start sending it workspace content. */
export function readWorkspaceAccess(workspaceId: string, petId: string): boolean {
  try {
    return localStorage.getItem(workspaceAccessKey(workspaceId, petId)) === 'true';
  } catch {
    return false;
  }
}

export function writeWorkspaceAccess(workspaceId: string, petId: string, value: boolean): void {
  try {
    localStorage.setItem(workspaceAccessKey(workspaceId, petId), String(value));
  } catch {
    /* The open conversation still remembers the toggle for this session. */
  }
}

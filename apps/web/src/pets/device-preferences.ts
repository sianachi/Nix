export type PetPlacement = 'left' | 'right';

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

export function readConversationModel(workspaceId: string, petId: string): string {
  try {
    const model = sessionStorage.getItem(`nix.pet.model.${workspaceId}.${petId}`) ?? '';
    return model.length <= 160 ? model : '';
  } catch {
    return '';
  }
}

export function writeConversationModel(workspaceId: string, petId: string, model: string): void {
  try {
    sessionStorage.setItem(`nix.pet.model.${workspaceId}.${petId}`, model);
  } catch {
    /* The open conversation retains the selection when storage is unavailable. */
  }
}

export function readDevicePreference(key: 'voice' | 'placement'): string {
  try {
    return localStorage.getItem(`nix.pet.${key}`) ?? '';
  } catch {
    return '';
  }
}

export function writeDevicePreference(key: 'voice' | 'placement', value: string): void {
  try {
    localStorage.setItem(`nix.pet.${key}`, value);
  } catch {
    /* Storage may be disabled. */
  }
  window.dispatchEvent(new Event('nix-pet-device-changed'));
}

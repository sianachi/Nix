export type PetPlacement = 'left' | 'right';

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

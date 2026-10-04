import { useNarrowViewport } from '../layout/viewport';
import { pageIsAvailable } from './pet-surface';
import { usePetSettings } from './use-pet-settings';
import { usePetSurface } from './use-pet-surface';

/** The navigation destination for the pet page, or null while there should be none: the
 * companion is off, has no active pet, or this device's surface preference does not offer a page
 * at this width. Named for the pet, since the destination is that one conversation. */
export function usePetNavEntry(): { readonly label: string } | null {
  const { saved } = usePetSettings();
  const surface = usePetSurface();
  const narrow = useNarrowViewport();
  const pet = saved?.settings.profiles.find((profile) => profile.id === saved.settings.activePetId);
  if (!saved?.settings.enabled || !pet || !pageIsAvailable(surface, narrow)) return null;
  return { label: pet.name };
}

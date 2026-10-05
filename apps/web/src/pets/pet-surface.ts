import { type PetSurface } from './device-preferences';

/** Whether a tap on the launcher goes to the chat page rather than opening the floating panel. */
export function chatOpensAsPage(surface: PetSurface, narrow: boolean): boolean {
  return surface === 'page' || (surface === 'page-on-phones' && narrow);
}

/** Whether the chat page is something to offer at all: wherever the launcher leads to it, and
 * under `both`, where the page is a second way in beside the panel. */
export function pageIsAvailable(surface: PetSurface, narrow: boolean): boolean {
  return chatOpensAsPage(surface, narrow) || surface === 'both';
}

/** Whether the pet floats over the workspace at all. Choosing the page everywhere is choosing
 * not to have it float: the navigation entry is then the way in, and the launcher is not drawn. */
export function launcherFloats(surface: PetSurface): boolean {
  return surface !== 'page';
}

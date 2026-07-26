/**
 * @nix/ui - the Industry design system as React components.
 *
 * Layered: `primitives/` (frame, typography, icons, interaction states) below `controls/`
 * (buttons and, as they land, the rest of the form and navigation set), with `patterns/` above
 * them once composed pieces arrive. Higher layers compose lower ones; nothing reaches past a
 * layer to raw markup for something the layer below already provides.
 *
 * **This file re-exports layers, never individual components.** Each layer owns a barrel of its
 * own, so a goal adding a control and a goal adding a primitive touch different files and can
 * land in either order. A single flat barrel made every component addition a write to one shared
 * file, which with several UI goals in flight is a merge conflict on all of them - and a conflict
 * in a list of exports resolves cleanly right up until someone drops a line and a component
 * silently stops being importable.
 *
 * Adding a layer is the only reason to edit this file.
 *
 * The package ships no stylesheet. Consumers own one Tailwind entry that imports the tokens:
 *
 *   @import 'tailwindcss';
 *   @import '@nix/design-tokens';
 *   @source '../../packages/ui/src';
 */

export * from './primitives';
export * from './controls';
export { cn } from './lib/cn';

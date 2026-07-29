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
 * The package ships no stylesheet. Consumers own one Tailwind entry that imports the tokens and
 * then names this package's source:
 *
 *   @import 'tailwindcss';
 *   @import '@nix/design-tokens';
 *   @source '<relative path to>/packages/ui/src';
 *
 * The @source line is not optional and its depth is the consumer's own: Tailwind v4 resolves the
 * path against the file the directive sits in, and it scans no further by itself, because this
 * package resolves through a pnpm symlink into node_modules and automatic detection skips that.
 * A consumer that leaves it out gets a build with no errors, no warnings, and every control in
 * this package missing its height, padding and tracking. This comment used to give one fixed
 * relative path, which was right for Storybook and wrong for apps/web - and apps/web shipped
 * broken for exactly that reason.
 */

export * from './primitives';
export * from './controls';
export { cn } from './lib/cn';

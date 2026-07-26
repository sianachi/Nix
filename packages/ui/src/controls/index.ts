/**
 * The controls layer: things a user operates. Buttons today; form controls, tags and cards as
 * they land.
 *
 * Controls compose primitives and never reach past them to raw markup for something the layer
 * below already provides. See `primitives/index.ts` for why each layer carries its own barrel.
 */

export { Button, type ButtonProps, type ButtonVariant } from './Button';

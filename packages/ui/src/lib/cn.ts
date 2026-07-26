import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Join Tailwind class values, letting later classes win over earlier ones in
 * the same utility group.
 *
 * Every component builds its classes as `cn(variants(...), className)`, so a
 * caller's layout class (`mt-4`, `col-span-2`) can never silently coexist with
 * a conflicting internal one, and a CVA compound variant reliably overrides
 * the plain variant it refines.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

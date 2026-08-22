import { isAllowedUri } from '@tiptap/extension-link';

/**
 * Whether the Link extension will accept an address for a link mark.
 *
 * Keep this boundary beside the shared editor schema: an address accepted by a form but refused
 * by the mark command closes the form and silently loses the person's work. TipTap deliberately
 * accepts relative addresses and its built-in safe protocols while refusing executable and local
 * schemes. The extra non-empty check reflects the command boundary, where an empty href removes a
 * link rather than creating one.
 */
export function isAllowedLinkAddress(value: string): boolean {
  return value.trim().length > 0 && Boolean(isAllowedUri(value));
}

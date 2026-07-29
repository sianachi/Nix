import type { ReactNode } from 'react';

/**
 * The one place a cover picture is drawn - and the seam `<Duotone>` drops into.
 *
 * **This is the Duotone seam, and the swap is one import.** The design grammar says images go
 * through `<Duotone>` from `@nix/ui` (CLAUDE.md, styling rules). That component is being built in a
 * parallel goal and does not exist in this build yet, so this renders a plain `<img>` in the
 * meantime - deliberately, rather than this goal inventing a second Duotone that would then have to
 * be reconciled with the real one. The props below are *exactly* the interface that goal is
 * implementing, so when it lands the change here is:
 *
 *   -  import type { ReactNode } from 'react';
 *   +  import { Duotone } from '@nix/ui';
 *
 * and the `<img>` becomes a `<Duotone>` with the same props forwarded. Nothing else in the gallery
 * moves, because nothing else in the gallery renders a picture.
 *
 * **A component rather than an `<img>` inlined in the card**, purely so that seam is one place. A
 * gallery that wrote its own `<img>` per state would have three of them by the time the covers,
 * their failures and their empty case were all drawn, and the swap would be three edits with two
 * chances to leave one behind.
 */

export interface CoverImageProps {
  readonly src: string;

  /**
   * What a screen reader is told the picture is.
   *
   * Callers in this build pass the empty string - see the gallery card for why that is the correct
   * value there and not an oversight - but the prop is required rather than optional so that a
   * caller has to make the decision rather than inherit it by forgetting.
   */
  readonly alt: string;

  readonly className?: string;

  /** Called when the picture cannot be fetched or decoded. */
  readonly onError?: () => void;

  readonly loading?: 'lazy' | 'eager';
}

export function CoverImage({
  src,
  alt,
  className,
  onError,
  loading = 'lazy',
}: CoverImageProps): ReactNode {
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      // Decoded off the main thread. A wall of covers decoded synchronously blocks the scroll of
      // the very grid they are in.
      decoding="async"
      // **A privacy boundary, not a nicety.** A cover URL is arbitrary and third-party - somebody
      // pasted it into a property - and without this every reader's browser announces the page it
      // came from, which is a workspace address carrying the item id, to a host the workspace does
      // not control and cannot audit. It is the same argument app.css makes for refusing a font
      // CDN: a third party should not learn who is reading what merely because a picture is on the
      // page. This stays on whatever renders the picture, including after the Duotone swap.
      referrerPolicy="no-referrer"
      {...(onError === undefined ? {} : { onError })}
    />
  );
}

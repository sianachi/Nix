import { Duotone } from '@nix/ui';
import { useEffect, type ReactNode } from 'react';

import { useApiClient } from '../../api/api-client-provider';
import { fileImageReferenceItemId, useFileImagePreview } from '../../properties/image-value';

/**
 * The one place a cover picture is drawn.
 *
 * **Covers go through `<Duotone>`**, which is the design grammar's answer for any image
 * (AGENTS.md, styling rules): it maps the picture's luminance onto two token colours so a wall of
 * arbitrary photographs reads as one surface rather than as somebody's camera roll. This file
 * existed first as a seam - a plain `<img>` with exactly Duotone's interface - because the two were
 * built in parallel and the treatment did not exist yet. It now forwards to the real thing, and the
 * props did not have to move.
 *
 * **A component rather than an `<img>` inlined in the card**, so that seam is one place. A gallery
 * that wrote its own picture per state would have three by the time the covers, their failures and
 * their empty case were all drawn, and this swap would have been three edits with two chances to
 * leave one behind.
 *
 * **What moved off this file and into Duotone**, because they belong to whatever renders a picture
 * rather than to the gallery: `referrerPolicy="no-referrer"` - a privacy boundary and not a nicety,
 * since a cover URL is arbitrary third-party and without it every reader's browser announces a
 * workspace address carrying the item id to a host nobody here controls or can audit - along with
 * `decoding="async"` and the lazy default. Duotone sets all three and its own tests hold them, so
 * this file no longer restates them.
 *
 * **`src` is not always a web address.** A cover set from a chosen or dropped file - see
 * `properties/image-value.tsx` - stores a reference to an uploaded file item rather than an
 * address, because there is no public URL for one (AGENTS.md: files use capability URLs, never
 * Core bytes). This is the one place that reference is resolved to something `<Duotone>` can
 * fetch: a local object URL, obtained the same way `note-image-view.tsx` resolves its own
 * `fileItemId` attribute. The gallery card above stays unaware of which kind of value it is
 * passing down.
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

  /**
   * Called when the picture cannot be fetched or decoded.
   *
   * **Required here, though Duotone types it optional.** A failed image with a non-empty `alt`
   * stops being a replaced element, so the caller's sizing is discarded and the box collapses to
   * the width of the alt text - which in a grid reflows every card around it. The gallery's answer
   * is to replace the frame rather than let a broken one sit in the layout, and it can only do that
   * if it is told. A caller that does not care what failure looks like has not thought about it.
   */
  readonly onError: () => void;

  readonly loading?: 'lazy' | 'eager';
}

export function CoverImage({
  src,
  alt,
  className,
  onError,
  loading = 'lazy',
}: CoverImageProps): ReactNode {
  const client = useApiClient();
  const fileItemId = fileImageReferenceItemId(src);
  const preview = useFileImagePreview(client, fileItemId);

  // A file reference's failure comes from the upload hook rather than from an `img` load event,
  // so it has no `onError` of its own to fire - this is what tells the caller instead. Effect
  // rather than inline, because rendering must not have side effects, and this one updates state
  // one level up (`failedCovers` in `gallery-view.tsx`).
  useEffect(() => {
    if (fileItemId !== null && preview.status === 'error') onError();
  }, [fileItemId, preview.status, onError]);

  if (fileItemId !== null) {
    // Loading and error both draw nothing here: the frame around this component - `CoverFrame` in
    // `gallery-view.tsx` - is what reserves the space and, once `onError` above has run, what
    // switches to the words explaining why.
    if (preview.status !== 'ready') return null;
    return (
      <Duotone
        src={preview.url}
        alt={alt}
        loading={loading}
        onError={onError}
        {...(className === undefined ? {} : { className })}
      />
    );
  }

  // `className` is spread rather than passed, because under `exactOptionalPropertyTypes` an
  // optional prop is either given or not given: handing it an explicit `undefined` is a different
  // thing from omitting it, and Duotone declares it optional. The same idiom appears on the list
  // view's `sort`.
  return (
    <Duotone
      src={src}
      alt={alt}
      loading={loading}
      onError={onError}
      {...(className === undefined ? {} : { className })}
    />
  );
}

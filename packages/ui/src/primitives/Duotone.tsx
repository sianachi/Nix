import { useId, type ReactElement } from 'react';

import { cn } from '../lib/cn';

/**
 * <Duotone> - the treatment every image in the product wears.
 *
 * A duotone maps an image's luminance onto two colours: the darkest pixels become one, the
 * lightest the other, and everything between is a straight interpolation of the two. It exists so
 * that a wall of user-supplied covers - screenshots, stock photography, somebody's camera roll -
 * reads as one surface rather than as a colour riot inside a mono, steel-accented interface.
 *
 * **How, and why this way.** An SVG filter, applied to the `<img>` itself:
 *
 *     luminanceToAlpha      a stencil whose alpha is the pixel's luminance
 *     flood + composite     the highlight colour, cut to that stencil
 *     flood + composite     the shadow colour, cut to the image's own alpha
 *     merge                 highlight over shadow
 *
 * which composites to `highlight * luminance + shadow * (1 - luminance)`: an actual gradient map
 * rather than an approximation of one.
 *
 * The two alternatives were a `mix-blend-mode` sandwich (grayscale the image, then a `lighten`
 * layer and a `multiply` layer above it) and the `background-blend-mode` version of the same idea.
 * Both were rejected for one reason: they tint an image by painting *over* it. A cover that fails
 * to load leaves those layers behind as a solid coloured rectangle - the component would be
 * drawing its own failure state, which is precisely what this one refuses to do (see `onError`
 * below). They are also channel-wise `max` and `multiply` rather than a luminance map, so
 * mid-tones keep whatever hue they arrived with and only the extremes move. The filter touches
 * only pixels the image actually has, and where filters are unsupported it degrades to the
 * untreated photograph instead of to a coloured box.
 *
 * **The colours are ramp steps, deliberately.** `--color-accent-900` in the shadows,
 * `--color-neutral-100` in the highlights. Everywhere else in this library a component reaches for
 * a semantic role because roles move with the ground and ramp steps do not - and here that is the
 * requirement rather than the mistake. Roles *invert*: `--color-foreground` is ink on paper and
 * paper on ink. Built from those, a photograph would render as its own negative on the dark
 * ground: a sky darker than the hills under it, faces lit from the wrong side. An image's
 * luminance is content, not chrome. Which is also why nothing here needs a `dark:` variant - there
 * is no value in this component that should change with the light.
 *
 * The accent goes in the shadows because a mono scheme has exactly one hue to spend and the dense
 * end of an image is where spending it registers; a near-neutral highlight keeps the pale end from
 * reading as a colour cast laid over somebody's photograph.
 *
 * **`referrerPolicy="no-referrer"` is not a preference.** A cover URL is arbitrary third-party
 * bytes. Without it, every viewer's browser announces the workspace URL - which carries the item
 * id - to a host the workspace does not control, on every render. Tenant isolation is the product's
 * pitch, and the app's stylesheet refuses a font CDN on the same argument. The component sets it;
 * there is no prop that unsets it.
 *
 * **Failure belongs to the caller.** `onError` fires and this component adds nothing of its own:
 * no placeholder, no message, no retry. A gallery has to tell "no cover configured" apart from
 * "a cover whose value was never set" apart from "a cover that failed to load", and a component
 * printing its own wording would fight the only code that knows the difference.
 *
 * That is a statement about what *this* component draws, and it is worth being exact about what
 * the browser draws in the gap before the caller reacts. A failed `<img>` is not blank: the user
 * agent paints its own broken-image chrome, and with a non-empty `alt` it stops being a replaced
 * element altogether - the caller's `h-40 w-72 object-cover` is discarded and the box collapses to
 * the width of the alt text, which in a grid reflows the card around it. So `onError` is
 * optional in the type and mandatory in practice: **a caller that renders `<Duotone>` and does not
 * replace it on error has shipped the browser's default failure state, not this library's.**
 * `Duotone.stories.tsx` shows the replacement, and it replaces rather than overlays for exactly
 * this reason.
 *
 * **Two obligations that come with "sizing belongs to the caller".** Reserve the box - a lazy
 * image with no height never enters the viewport and so never loads at all, and one that arrives
 * into an unreserved box shifts every cover below it. And give a pale cover an edge: the highlight
 * tone is 1.03:1 against the light ground, so a screenshot of a document rendered bare on the page
 * has no boundary. On `bg-surface` the surface change is the boundary and nothing more is needed,
 * which is why the frame is not baked in here (borders are the last resort, not the first).
 *
 * There are no transitions, so `prefers-reduced-motion` has nothing to reduce. Fading a cover in
 * on load would mean holding load state here, and on a lazy image that fade arrives mid-scroll -
 * motion nobody asked for, in a component whose job is to be still.
 */

/**
 * The characters a `useId` value may not carry into a CSS `url(#...)` reference. Hoisted because a
 * regex literal builds a fresh `RegExp` every time it is evaluated, and this one is evaluated once
 * per cover per render.
 */
const UNSAFE_IN_URL_REFERENCE = /[^a-zA-Z0-9_-]/g;

export interface DuotoneProps {
  /** Absolute http/https URL. (Stories pass a `data:` plate; the platform does not mind.) */
  readonly src: string;
  /** Empty string when the image carries nothing the surrounding text does not already say. */
  readonly alt: string;
  /** Sizing and aspect ratio belong to the caller. */
  readonly className?: string;
  /** Called when the image fails to load. The caller decides what that means and says so. */
  readonly onError?: () => void;
  /** Defaults to 'lazy'. */
  readonly loading?: 'lazy' | 'eager';
}

export function Duotone({
  src,
  alt,
  className,
  onError,
  loading = 'lazy',
}: DuotoneProps): ReactElement {
  // Every instance carries its own filter. Two `<Duotone>` elements sharing one id would render
  // identically - the definitions are byte-identical, so re-resolving to a surviving twin is a
  // visual no-op - but it is a duplicate id in the document, and nothing owns the definition's
  // lifetime: the last cover to unmount takes the filter every other cover is pointing at. Per
  // instance, that costs eleven extra elements, so a 60-cover gallery carries about 660 nodes
  // describing one filter. The alternative is a single module-level definition rendered once at
  // the app root, which trades those nodes for a component that silently renders untreated
  // anywhere the root is not - a worse failure, and one that only shows up in whichever test
  // forgets the provider. Revisit when a gallery is large enough to be virtualized, because
  // virtualization is what makes the mount churn constant.
  //
  // `useId` is per-instance and stable across re-renders.
  //
  // The strip is a guard rather than a fix: the shape of a useId value is React's to change and it
  // has changed twice already (":r0:", then guillemets, "_r_0_" today), while this one ends up
  // inside a CSS `url(#...)` reference. Which punctuation each browser reads back the same way
  // there is not a thing to discover in production.
  const instanceId = useId().replace(UNSAFE_IN_URL_REFERENCE, '');
  const filterId = `duotone-${instanceId}`;

  return (
    <>
      <img
        src={src}
        alt={alt}
        // `block` only: an inline image sits on the text baseline and leaves a descender's worth
        // of gap under it inside a card, which is a layout bug rather than a size. Sizing, fit and
        // aspect ratio stay the caller's, and `cn` lets a caller's own display class win.
        className={cn('block', className)}
        // Inline because the reference names this instance's filter; there is no static class that
        // can carry a generated id.
        style={{ filter: `url(#${filterId})` }}
        loading={loading}
        // A gallery is the first screen here to fetch N remote images, and there is no
        // virtualization anywhere: decoding off the main thread keeps the scroll from stepping.
        decoding="async"
        referrerPolicy="no-referrer"
        onError={onError}
      />

      {/*
        The filter's home. Zero-sized and out of flow so it is neither a flex item, a grid item,
        nor a line box - a `<Duotone>` takes up exactly the space of its image. That is a statement
        about layout and not about structure: it is still a second child, so a parent's
        `nth-child`, `first:` or `last:` lands on it. `<defs>` content is never painted, so nothing
        here reaches the screen except through the reference above.
      */}
      <svg aria-hidden="true" focusable="false" className="absolute size-0 overflow-hidden">
        <defs>
          {/*
            sRGB rather than the linearRGB default: the flood colours are token values authored in
            sRGB, and the luminance stencil is what the eye reads off the photograph. Left on the
            default, both are converted first and the map lands somewhere neither was chosen for.

            The region is pinned to the image's own box. The default is -10%/-10%/120%/120%, and
            not one primitive here displaces a pixel, so the extra 44% of area is guaranteed to
            composite away - filtered, then discarded, on every cover.
          */}
          <filter id={filterId} x="0" y="0" width="1" height="1" colorInterpolationFilters="sRGB">
            {/* Alpha becomes the pixel's luminance; the clip keeps a transparent PNG transparent. */}
            <feColorMatrix type="luminanceToAlpha" result="luminance" />
            <feComposite in="luminance" in2="SourceGraphic" operator="in" result="stencil" />

            {/*
              `style`, not the `floodColor` prop React also offers. A presentation attribute does
              not resolve `var()`, so the attribute form falls back to black in silence - no
              warning, no exception, just every photograph in the product rendered as a black-on-
              black silhouette. `Duotone.test.tsx` asserts the mechanism as well as the two tones.
            */}
            <feFlood style={{ floodColor: 'var(--color-neutral-100)' }} result="highlightFlood" />
            <feComposite
              in="highlightFlood"
              in2="stencil"
              operator="in"
              result="highlightsInPlace"
            />

            <feFlood style={{ floodColor: 'var(--color-accent-900)' }} result="shadowFlood" />
            <feComposite
              in="shadowFlood"
              in2="SourceGraphic"
              operator="in"
              result="shadowsInPlace"
            />

            <feMerge>
              <feMergeNode in="shadowsInPlace" />
              <feMergeNode in="highlightsInPlace" />
            </feMerge>
          </filter>
        </defs>
      </svg>
    </>
  );
}

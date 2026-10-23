import { SITE_PALETTE, type SiteGround } from '@nix/design-tokens/site';

import type { SiteBuildManifest } from '../manifest.js';

/**
 * The Nix default theme's stylesheet, shaped by the site's accent, heading mark, typeface and
 * spacing.
 *
 * **Every colour comes from `SITE_PALETTE`**, which `@nix/design-tokens` traces to the token sheet
 * and checks for contrast; this file only names roles. The one outside colour is the site's own
 * accent, which decorates (item glyphs, rules, the current page's marker) as it is, and colours
 * links only after `readableAccent` has pulled it to 4.5:1, so a poorly chosen accent cannot make
 * a page unreadable. On the dark ground it is mixed towards the text colour so it stays visible.
 *
 * The signature is the item glyph: Nix's one kind of thing, drawn as a small square, joined by
 * hairlines into the tree the site really is - in the header mark, the home page's map and the
 * docs sidebar.
 */

export type HeadingMark = SiteBuildManifest['settings']['headingMark'];
export type Typeface = SiteBuildManifest['settings']['typeface'];
export type Spacing = SiteBuildManifest['settings']['spacing'];

/**
 * The type families a site can choose, each self-hosted from its `@fontsource` package. `meta` is
 * the face for dates, tags and other metadata: the rounded default keeps the system monospace, the
 * others set metadata in their own face so a serif site does not read like code.
 */
const TYPEFACES: Readonly<
  Record<Typeface, { readonly family: string; readonly fallback: string; readonly meta: string }>
> = {
  rounded: {
    family: 'Nunito Sans',
    fallback: "system-ui,-apple-system,'Segoe UI',sans-serif",
    meta: 'var(--mono)',
  },
  serif: { family: 'Literata', fallback: "Georgia,'Times New Roman',serif", meta: 'var(--sans)' },
  legible: {
    family: 'Atkinson Hyperlegible Next',
    fallback: "system-ui,-apple-system,'Segoe UI',sans-serif",
    meta: 'var(--sans)',
  },
};

const FONT_FILES = [
  ['400', 'normal'],
  ['400', 'italic'],
  ['700', 'normal'],
  ['700', 'italic'],
  ['800', 'normal'],
] as const;

/** The font files a typeface publishes: `package` is the `@fontsource` package they come from. */
export function themeFonts(typeface: Typeface): readonly {
  readonly weight: string;
  readonly style: string;
  readonly package: string;
  readonly file: string;
}[] {
  const slug = TYPEFACES[typeface].family.toLowerCase().replaceAll(' ', '-');
  return FONT_FILES.map(([weight, style]) => ({
    weight,
    style,
    package: `@fontsource/${slug}`,
    file: `${slug}-latin-${weight}-${style}.woff2`,
  }));
}

/** The multiplier on block, section and row spacing. */
const RHYTHM: Readonly<Record<Spacing, number>> = { compact: 0.8, comfortable: 1, airy: 1.3 };

/**
 * Rules a heading mark adds over the square the base sheet draws. `none` hides every glyph: where
 * a glyph means something (the docs tree's "here"), `aria-current` and weight already say it.
 */
const MARKS: Readonly<Record<HeadingMark, string>> = {
  square: '',
  diamond:
    '.nix-glyph,.nix-mark::before,.nix-mark i{border-radius:1px;transform:rotate(45deg) scale(.8)}',
  none: '.nix-glyph,.nix-mark{display:none}',
};

function channel(hex: string, at: number): number {
  return Number.parseInt(hex.slice(at, at + 2), 16) / 255;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const c = channel(hex, at);
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

export function contrast(first: string, second: string): number {
  const [low = 0, high = 0] = [luminance(first), luminance(second)].sort((a, b) => a - b);
  return (high + 0.05) / (low + 0.05);
}

/**
 * The accent as a link colour: mixed towards the text colour, in 5% steps, until it reads at 4.5:1
 * on every background a link can sit on. A dark accent on paper comes back unchanged.
 */
export function readableAccent(accent: string, values: SiteGround): string {
  const backgrounds = [values.ground, values.surface];
  for (let step = 0; step <= 20; step += 1) {
    const mixed = `#${[1, 3, 5]
      .map((at) => {
        const value =
          channel(accent, at) + (channel(values.text, at) - channel(accent, at)) * (step / 20);
        return Math.round(value * 255)
          .toString(16)
          .padStart(2, '0');
      })
      .join('')}`;
    if (backgrounds.every((background) => contrast(mixed, background) >= 4.5)) {
      return mixed;
    }
  }
  return values.text;
}

function ground(values: SiteGround): string {
  const [s1, s2, s3, s4, s5, s6, other] = values.series;
  return `
  --ground: ${values.ground};
  --surface: ${values.surface};
  --text: ${values.text};
  --muted: ${values.muted};
  --border: ${values.border};
  --link: ${values.link};
  --code: ${values.code};
  --mark: ${values.mark};
  --on-accent: ${values.onAccent};
  --syn-keyword: ${values.syntax.keyword};
  --syn-string: ${values.syntax.string};
  --syn-number: ${values.syntax.number};
  --syn-comment: ${values.syntax.comment};
  --syn-title: ${values.syntax.title};
  --syn-type: ${values.syntax.type};
  --series-0: ${s1 ?? values.text};
  --series-1: ${s2 ?? values.text};
  --series-2: ${s3 ?? values.text};
  --series-3: ${s4 ?? values.text};
  --series-4: ${s5 ?? values.text};
  --series-5: ${s6 ?? values.text};
  --series-6: ${other ?? values.muted};`;
}

export function themeCss(settings: {
  readonly accent: string;
  readonly headingMark: HeadingMark;
  readonly typeface: Typeface;
  readonly spacing: Spacing;
}): string {
  const face = TYPEFACES[settings.typeface];
  const fonts = themeFonts(settings.typeface)
    .map(
      (font) =>
        `@font-face{font-family:'${face.family}';font-style:${font.style};font-weight:${font.weight};font-display:swap;src:url(fonts/${font.file}) format('woff2')}`,
    )
    .join('\n');
  const DARK = `color-scheme: dark;${ground(SITE_PALETTE.dark)}
  --link: ${readableAccent(settings.accent, SITE_PALETTE.dark)};
  --accent: color-mix(in oklab, var(--accent-base) 55%, var(--text));`;
  const LIGHT = `color-scheme: light;${ground(SITE_PALETTE.light)}
  --link: ${readableAccent(settings.accent, SITE_PALETTE.light)};
  --accent: var(--accent-base);`;

  return `${fonts}
:root{--accent-base:${settings.accent};${LIGHT}
  --paper:${SITE_PALETTE.light.ground};
  --sans:'${face.family}',${face.fallback};
  --mono:ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;
  --meta:${face.meta};
  --rhythm:${String(RHYTHM[settings.spacing])};
  --radius-sm:4px;--radius-md:8px;--radius-lg:14px;
  --measure:40rem;--gutter:clamp(1rem,4vw,2.5rem);
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK}}}
:root[data-theme=dark]{${DARK}}

*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%;scroll-padding-top:5rem}
body{margin:0;background:var(--ground);color:var(--text);font-family:var(--sans);font-size:1.0625rem;line-height:1.65;font-kerning:normal;text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased}
.nix-layout-blog{font-size:1.125rem}
::selection{background:var(--mark);color:var(--text)}
img,svg{max-width:100%}
img{height:auto}
a{color:var(--link);text-decoration-line:underline;text-decoration-thickness:1px;text-underline-offset:.2em;text-decoration-color:color-mix(in oklab,var(--link) 45%,transparent)}
a:hover{text-decoration-color:currentColor;text-decoration-thickness:2px}
:focus-visible{outline:2px solid var(--link);outline-offset:3px;border-radius:var(--radius-sm)}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.nix-skip{position:absolute;left:var(--gutter);top:-4rem;z-index:20;padding:.6rem 1rem;background:var(--accent);color:var(--on-accent);font-weight:700;border-radius:var(--radius-md);text-decoration:none}
.nix-skip:focus{top:.75rem}
[hidden]{display:none!important}

/* The item glyph: one square per item. Filled is "here", hollow is "elsewhere". */
.nix-glyph{display:inline-block;flex:none;width:.55em;height:.55em;border-radius:2px;background:var(--accent);vertical-align:.08em}
.nix-glyph-hollow{background:transparent;box-shadow:inset 0 0 0 1.5px var(--accent)}

/* Header */
.nix-top{position:sticky;top:0;z-index:10;background:color-mix(in oklab,var(--ground) 88%,transparent);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--border)}
.nix-top-inner{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1.5rem;max-width:84rem;margin:0 auto;padding:.7rem var(--gutter)}
.nix-brand{display:inline-flex;align-items:center;gap:.65rem;color:var(--text);text-decoration:none;font-weight:800;font-size:1.05rem;letter-spacing:-.01em;margin-right:auto}
.nix-brand:hover{color:var(--text)}
.nix-mark{position:relative;display:inline-block;width:1.15rem;height:1.15rem;flex:none}
.nix-mark::before,.nix-mark::after{content:'';position:absolute;border-radius:2px}
.nix-mark::before{left:0;top:0;width:.62rem;height:.62rem;background:var(--accent)}
.nix-mark::after{left:.3rem;top:.62rem;width:.85rem;height:.53rem;border-left:1.5px solid var(--accent);border-bottom:1.5px solid var(--accent);border-radius:0 0 0 2px}
.nix-mark i{position:absolute;right:0;bottom:0;width:.42rem;height:.42rem;border-radius:2px;box-shadow:inset 0 0 0 1.5px var(--accent)}
.nix-nav ul{display:flex;flex-wrap:wrap;gap:.25rem 1.25rem;margin:0;padding:0;list-style:none}
.nix-nav a{color:var(--muted);text-decoration:none;font-weight:700;font-size:.9375rem}
.nix-nav a:hover,.nix-nav a[aria-current]{color:var(--text)}
.nix-tools{display:flex;align-items:center;gap:.5rem}
.nix-theme{display:inline-grid;place-items:center;width:2.5rem;height:2.5rem;margin:0;padding:0;border:1px solid var(--border);border-radius:999px;background:transparent;color:var(--text);cursor:pointer}
.nix-theme:hover{background:var(--surface)}
.nix-theme span{width:1rem;height:1rem;border-radius:50%;box-shadow:inset 0 0 0 1.5px currentColor;background:linear-gradient(90deg,currentColor 50%,transparent 50%)}

/* Search (enhanced by the theme script; hidden without it) */
.nix-search{position:relative}
.nix-search input{width:min(16rem,52vw);height:2.5rem;padding:0 2.2rem 0 .85rem;border:1px solid var(--border);border-radius:999px;background:var(--surface);color:var(--text);font:inherit;font-size:.9375rem}
.nix-search input::placeholder{color:var(--muted);opacity:1}
.nix-search kbd{position:absolute;right:.6rem;top:50%;transform:translateY(-50%);font-family:var(--mono);font-size:.75rem;color:var(--muted);border:1px solid var(--border);border-radius:var(--radius-sm);padding:0 .3rem;pointer-events:none}
.nix-search-panel{position:absolute;right:0;top:calc(100% + .5rem);width:min(26rem,calc(100vw - 2rem));max-height:70vh;overflow:auto;background:var(--ground);border:1px solid var(--border);border-radius:var(--radius-md);box-shadow:0 16px 40px color-mix(in oklab,var(--text) 18%,transparent);padding:.5rem}
.nix-search-panel p{margin:.25rem .5rem;font-size:.8125rem;color:var(--muted);font-family:var(--meta)}
.nix-search-panel ul{list-style:none;margin:0;padding:0}
.nix-search-panel a{display:block;padding:.5rem .6rem;border-radius:var(--radius-sm);color:var(--text);text-decoration:none}
.nix-search-panel a:hover,.nix-search-panel a:focus-visible{background:var(--surface)}
.nix-search-panel small{display:block;color:var(--muted);font-family:var(--meta);font-size:.75rem}

/* Page frame */
.nix-main{max-width:84rem;margin:0 auto;padding:0 var(--gutter)}
.nix-prose{max-width:var(--measure)}
.nix-prose>*:first-child{margin-top:0}
.nix-prose p,.nix-prose ul,.nix-prose ol,.nix-prose blockquote,.nix-prose figure,.nix-prose pre,.nix-prose .nix-table,.nix-prose details,.nix-prose aside{margin:0 0 calc(1.15em * var(--rhythm))}
.nix-prose h2,.nix-prose h3,.nix-prose h4{position:relative;line-height:1.2;letter-spacing:-.015em;margin:calc(2.2em * var(--rhythm)) 0 .6em;font-weight:800}
.nix-prose h2{font-size:1.65rem}
.nix-prose h3{font-size:1.3rem;font-weight:700}
.nix-prose h4{font-size:1.1rem;font-weight:700}
.nix-prose h2,.nix-prose h3,.nix-prose h4{text-wrap:balance}.nix-prose p,.nix-prose li,.nix-hero-lead,.nix-lead,.nix-post-row p,.nix-card p{text-wrap:pretty}
.nix-anchor{margin-left:.35em;color:var(--muted);text-decoration:none;font-weight:400;opacity:0}
h2:hover .nix-anchor,h3:hover .nix-anchor,h4:hover .nix-anchor,.nix-anchor:focus-visible{opacity:1}
@media (hover:none){.nix-anchor{opacity:1}}
.nix-prose ul,.nix-prose ol{padding-left:1.35em}
.nix-prose li{margin:.3em 0}
.nix-prose li>p{margin:0}
.nix-prose ul>li::marker{color:var(--accent)}
.nix-prose ol>li::marker{color:var(--muted);font-family:var(--meta);font-size:.875em}
.nix-prose blockquote{margin-left:0;padding:.1em 0 .1em 1.25em;border-left:3px solid var(--accent);color:var(--muted);font-style:italic}
.nix-prose hr{border:0;height:1px;background:var(--border);margin:2.5em 0}
.nix-prose code{font-family:var(--mono);font-size:.875em;background:var(--code);padding:.12em .35em;border-radius:var(--radius-sm)}
.nix-prose mark{background:var(--mark);color:var(--text);padding:0 .15em;border-radius:2px}
.nix-align-center{text-align:center}.nix-align-right{text-align:right}.nix-align-justify{text-align:justify}
.nix-code{position:relative;overflow-x:auto;background:var(--code);border-radius:var(--radius-md);padding:1.05rem 1.25rem;font-size:.875rem;line-height:1.6;tab-size:2}
.nix-code[data-language]::before{content:attr(data-language);position:absolute;top:.6rem;left:1.25rem;font-family:var(--mono);font-size:.6875rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.nix-code[data-language],.nix-code-wrap .nix-code{padding-top:2.4rem}
.nix-code-wrap{position:relative}
.nix-copy{position:absolute;top:.4rem;right:.5rem;min-height:1.75rem;padding:0 .65rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--ground);color:var(--muted);font:inherit;font-family:var(--meta);font-size:.75rem;cursor:pointer}
.nix-copy:hover{color:var(--text);border-color:var(--accent)}
@media (pointer:coarse){.nix-copy{min-height:44px;min-width:44px}.nix-code-wrap .nix-code{padding-top:3.4rem}.nix-anchor{display:inline-block;min-width:44px;text-align:center}}
.nix-prose .nix-code code{background:none;padding:0;font-size:inherit;border-radius:0}
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-meta .hljs-keyword{color:var(--syn-keyword)}
.hljs-string,.hljs-regexp,.hljs-addition,.hljs-attr .hljs-string{color:var(--syn-string)}
.hljs-number,.hljs-symbol,.hljs-bullet,.hljs-variable.constant_{color:var(--syn-number)}
.hljs-comment,.hljs-quote,.hljs-deletion{color:var(--syn-comment);font-style:italic}
.hljs-title,.hljs-section,.hljs-function .hljs-title,.hljs-title.function_{color:var(--syn-title)}
.hljs-type,.hljs-built_in,.hljs-attr,.hljs-attribute,.hljs-name,.hljs-meta,.hljs-params,.hljs-selector-class{color:var(--syn-type)}
.nix-figure{margin-left:0;margin-right:0}
.nix-figure img{display:block;border-radius:var(--radius-md)}
.nix-diagram img{background:var(--paper);border:1px solid var(--border);padding:1rem}
.nix-diagram-source{margin-top:-.5rem}
.nix-table{overflow-x:auto;border:1px solid var(--border);border-radius:var(--radius-md)}
.nix-table table{width:100%;border-collapse:collapse;font-size:.9375rem}
.nix-table caption{text-align:left;padding:.6rem .8rem;font-weight:700}
.nix-table th,.nix-table td{padding:.55rem .8rem;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
.nix-table tr:last-child>*{border-bottom:0}
.nix-table thead th,.nix-table tbody:first-child>tr:first-child>th{background:var(--surface)}
.nix-table td{font-variant-numeric:tabular-nums}
.nix-callout{padding:.9rem 1.1rem;border-radius:var(--radius-md);background:var(--surface);border-left:3px solid var(--accent)}
.nix-callout>*:last-child{margin-bottom:0}
.nix-callout-label{margin:0 0 .3rem!important;font-family:var(--meta);font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.nix-callout-tip{border-left-color:var(--series-2)}.nix-callout-warning{border-left-color:var(--series-1)}.nix-callout-danger{border-left-color:var(--series-3)}
.nix-notice{padding:.7rem .9rem;border:1px dashed var(--border);border-radius:var(--radius-md);font-family:var(--meta);font-size:.8125rem;color:var(--muted)}
.nix-tasks{list-style:none;padding-left:0!important}
.nix-task{display:flex;gap:.6rem;align-items:baseline}
.nix-task>div>p{margin:0}
.nix-task-box{flex:none;width:.85em;height:.85em;border-radius:3px;box-shadow:inset 0 0 0 1.5px var(--muted);transform:translateY(.1em)}
.nix-task-done .nix-task-box{background:var(--accent);box-shadow:none}
.nix-task-done>div{color:var(--muted);text-decoration:line-through}
.nix-columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:1.5rem;margin-bottom:1.15em}
.nix-details{border:1px solid var(--border);border-radius:var(--radius-md);padding:.6rem .9rem}
.nix-details summary{cursor:pointer;font-weight:700}
.nix-details summary>p{display:inline;margin:0}
.nix-item-link a{display:block;padding:.8rem 1rem;border:1px solid var(--border);border-radius:var(--radius-md);text-decoration:none;font-weight:700}
.nix-ref-text{border-bottom:1px dotted var(--muted)}
.nix-file{display:flex;flex-wrap:wrap;align-items:baseline;gap:.4rem .8rem;padding:.8rem 1rem;border:1px solid var(--border);border-radius:var(--radius-md)}
.nix-video{margin:1.5rem 0}.nix-video video{display:block;width:100%;max-height:70vh;border-radius:var(--radius-md);background:var(--surface)}.nix-video figcaption{display:flex;flex-wrap:wrap;align-items:baseline;gap:.4rem .8rem;margin-top:.5rem}
.nix-file-link{font-weight:700}
.nix-file-meta{font-family:var(--meta);font-size:.8125rem;color:var(--muted)}

/* Indexes drawn from views */
.nix-index{list-style:none;margin:0 0 1.5rem;padding:0;border-top:1px solid var(--border)}
.nix-index a{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.4rem 1rem;padding:calc(.75rem * var(--rhythm)) 0;border-bottom:1px solid var(--border);color:var(--text);text-decoration:none}
.nix-index a:hover .nix-index-title{color:var(--link)}
.nix-index-title{font-weight:700}
.nix-index-facts{display:flex;flex-wrap:wrap;gap:.35rem;margin-left:auto}
.nix-index time{flex:none;color:var(--muted);font-family:var(--meta);font-size:.8125rem}
.nix-gallery{list-style:none;margin:0 0 1.5rem;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:calc(1.25rem * var(--rhythm))}
.nix-gallery a{display:flex;flex-direction:column;height:100%;border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;color:var(--text);text-decoration:none;background:var(--surface)}
.nix-gallery img,.nix-gallery-blank{display:block;width:100%;aspect-ratio:1200/630;object-fit:cover;background:var(--code)}
.nix-gallery-title{padding:.8rem 1rem;font-weight:700}
.nix-gallery-subtitle{margin-top:-.45rem;padding:0 1rem .8rem;color:var(--muted);font-size:.9375rem;line-height:1.45}
.nix-gallery .nix-facts-compact{margin:0 1rem 1rem;padding-top:.6rem}
.nix-board,.nix-chart-figure{margin:0 0 1.5rem}
.nix-board figcaption,.nix-chart-figure figcaption{font-weight:700;margin-bottom:.6rem}
.nix-board-paper{overflow-x:auto;max-width:46rem;margin-bottom:1rem;padding:.75rem;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--paper)}
.nix-board-paper svg{display:block;width:100%;height:auto;min-width:32rem}
.nix-chart{display:block;width:100%;height:auto;margin:.5rem 0 1rem}
.nix-chart-pie{max-width:14rem}
.nix-chart-text{fill:var(--muted);font-family:var(--meta);font-size:11px}
/* A chart with one series draws in the site accent, at its readable link strength. */
.nix-chart-figure:not(:has(.nix-chart-legend)) .nix-chart:not(.nix-chart-pie) .nix-chart-s0{fill:var(--link)}
.nix-chart-figure:not(:has(.nix-chart-legend)) .nix-chart:not(.nix-chart-pie) .nix-chart-line-s0{stroke:var(--link)}
.nix-chart-grid{stroke:var(--border)}
.nix-chart-hatch,.nix-chart-separator{stroke:var(--ground)}
.nix-chart-empty{fill:var(--border)}
.nix-chart-translucent{opacity:.5}
${[0, 1, 2, 3, 4, 5, 6].map((role) => `.nix-chart-s${String(role)}{fill:var(--series-${String(role)})}.nix-chart-line-s${String(role)}{stroke:var(--series-${String(role)})}`).join('')}
.nix-chart-legend{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:.3rem 1rem;font-size:.875rem}
.nix-chart-legend li{display:flex;align-items:center;gap:.4rem}

/* The item tree: a list whose hairlines are the hierarchy */
.nix-tree,.nix-tree ul{list-style:none;margin:0;padding:0}
.nix-tree ul{margin-left:.27em}
.nix-tree li{position:relative;padding-left:1.15rem}
.nix-tree ul>li::before{content:'';position:absolute;left:0;top:0;width:.8rem;height:1.05em;border-left:1px solid var(--border);border-bottom:1px solid var(--border);border-bottom-left-radius:4px}
.nix-tree ul>li:not(:last-child)::after{content:'';position:absolute;left:0;top:1em;bottom:0;border-left:1px solid var(--border)}
.nix-tree>li{padding-left:0}

/* Shared article header */
.nix-crumbs{margin:0 0 1.25rem;font-family:var(--meta);font-size:.8125rem;color:var(--muted)}
.nix-crumbs ol{display:flex;flex-wrap:wrap;gap:.2rem .5rem;list-style:none;margin:0;padding:0}
.nix-crumbs li+li::before{content:'/';margin-right:.5rem;color:var(--border)}
.nix-crumbs a{color:var(--muted);text-decoration:none}
.nix-crumbs a:hover{color:var(--link);text-decoration:underline}
.nix-title{margin:0;font-weight:800;letter-spacing:-.03em;line-height:1.04;font-size:clamp(2.1rem,1.4rem + 3vw,3.25rem);text-wrap:balance}
.nix-meta{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem 1rem;margin:1rem 0 0;font-family:var(--meta);font-size:.8125rem;color:var(--muted)}
.nix-lead{max-width:40rem;margin:1rem 0 0;font-size:clamp(1.1rem,1rem + .4vw,1.3rem);line-height:1.5;color:var(--muted)}
.nix-facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));gap:.9rem 1.5rem;margin:1.5rem 0 0;padding:1rem 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.nix-facts dt{font-family:var(--meta);font-size:.75rem;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.nix-facts dd{margin:.2rem 0 0;line-height:1.45;overflow-wrap:anywhere}
.nix-facts-compact{grid-template-columns:1fr;gap:.45rem;margin:.8rem 0 0;padding:.7rem 0 0;border-bottom:0}
.nix-facts-compact dd{font-size:.875rem;color:var(--muted)}
.nix-tags{display:flex;flex-wrap:wrap;gap:.4rem;list-style:none;margin:0;padding:0}
.nix-tag{display:inline-block;padding:.1rem .55rem;border:1px solid var(--border);border-radius:999px;color:var(--muted);text-decoration:none;font-family:var(--meta);font-size:.75rem;line-height:1.6}
a.nix-tag:hover{border-color:var(--accent);color:var(--text)}
.nix-pager{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin:3.5rem 0 0;padding-top:1.5rem;border-top:1px solid var(--border)}
.nix-pager a{display:block;padding:.9rem 1.1rem;border:1px solid var(--border);border-radius:var(--radius-md);color:var(--text);text-decoration:none;font-weight:700}
.nix-pager a:hover{border-color:var(--accent)}
.nix-pager small{display:block;font-family:var(--meta);font-weight:400;font-size:.75rem;color:var(--muted);margin-bottom:.15rem}
.nix-pager-next{grid-column:2;text-align:right}

/* Home: the site's own tree, drawn as the hero */
.nix-hero{padding:calc(clamp(3rem,8vw,6.5rem) * var(--rhythm)) 0 calc(clamp(2rem,5vw,3.5rem) * var(--rhythm))}
.nix-eyebrow{display:flex;align-items:center;gap:.6rem;margin:0 0 1.25rem;font-family:var(--meta);font-size:.8125rem;font-weight:400;letter-spacing:.04em;color:var(--muted)}
.nix-hero-title{margin:0;max-width:16ch;font-weight:800;letter-spacing:-.045em;line-height:.98;font-size:clamp(2.75rem,1.5rem + 6vw,6rem);text-wrap:balance}
.nix-hero-lead{max-width:34rem;margin:1.5rem 0 0;font-size:clamp(1.15rem,1rem + .6vw,1.4rem);line-height:1.5;color:var(--muted)}
.nix-map{margin:0 0 calc(clamp(3rem,6vw,5rem) * var(--rhythm))}
.nix-map-root{display:flex;align-items:center;gap:.6rem;margin:0;font-family:var(--meta);font-size:.8125rem;color:var(--muted)}
.nix-map-branches{display:grid;grid-template-columns:repeat(auto-fit,minmax(13.5rem,1fr));gap:0 2rem;margin:0 0 0 .27rem;padding:0;list-style:none;border-left:1px solid var(--border)}
.nix-map-branch{position:relative;padding:1.4rem 0 0 1.4rem}
.nix-map-branch::before{content:'';position:absolute;left:0;top:2.05rem;width:1rem;border-top:1px solid var(--border)}
.nix-map-branch>a{display:flex;align-items:baseline;gap:.55rem;font-size:1.3rem;font-weight:800;letter-spacing:-.015em;color:var(--text);text-decoration:none}
.nix-map-branch>a:hover{color:var(--link)}
.nix-map-branch>p{margin:.15rem 0 .6rem 1.15rem;font-family:var(--meta);font-size:.75rem;color:var(--muted)}
.nix-map-branch .nix-tree{margin-left:.15rem;font-size:.9375rem}
.nix-map-branch .nix-tree a{color:var(--muted);text-decoration:none}
.nix-map-branch .nix-tree a:hover{color:var(--link);text-decoration:underline}
@media (min-width:56rem){
  .nix-map-branches{border-left:0;border-top:1px solid var(--border);margin:1rem 0 0}
  .nix-map-branch{padding:1.6rem 0 0}
  .nix-map-branch::before{left:.27rem;top:0;width:0;height:1.25rem;border-top:0;border-left:1px solid var(--border)}
  .nix-map-branch>p{margin-left:1.1rem}
}
.nix-home-body{padding-bottom:4rem}

/* Docs layout */
.nix-docs{display:grid;grid-template-columns:minmax(0,1fr);gap:2.5rem;padding:calc(2rem * var(--rhythm)) 0 4rem}
.nix-sidebar{display:none}
.nix-sidebar-mobile{border:1px solid var(--border);border-radius:var(--radius-md);padding:.65rem .9rem;margin-bottom:.5rem}
.nix-sidebar-mobile summary{cursor:pointer;font-weight:700}
.nix-sidebar-mobile .nix-tree{margin-top:.75rem}
.nix-side-tree{font-size:.9375rem;line-height:1.45}
.nix-side-tree li{padding-top:.18rem;padding-bottom:.18rem}
.nix-side-tree ul>li::before{height:.95em}
.nix-side-tree a{display:inline-flex;gap:.5rem;align-items:baseline;color:var(--muted);text-decoration:none}
.nix-side-tree a:hover{color:var(--text)}
.nix-side-tree a[aria-current=page]{color:var(--text);font-weight:700}
.nix-side-tree>li>a{color:var(--text);font-weight:700;margin-top:.35rem}
.nix-toc{display:none}
.nix-toc h2{margin:0 0 .6rem;font-family:var(--meta);font-size:.75rem;font-weight:400;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.nix-toc ul{list-style:none;margin:0;padding:0 0 0 .8rem;border-left:1px solid var(--border);font-size:.875rem}
.nix-toc li{margin:.35rem 0}
.nix-toc .nix-toc-3{padding-left:.8rem}
.nix-toc a{color:var(--muted);text-decoration:none}
.nix-toc a:hover{color:var(--link)}
.nix-toc-folded{margin:1.5rem 0 0;border:1px solid var(--border);border-radius:var(--radius-md);padding:.65rem .9rem}
.nix-toc-folded summary{cursor:pointer;font-weight:700}
.nix-toc-folded ul{list-style:none;margin:.5rem 0 0;padding:0;font-size:.9375rem}
.nix-toc-folded li{margin:.35rem 0}
.nix-toc-folded .nix-toc-3{padding-left:.8rem}
.nix-toc-folded a{color:var(--muted);text-decoration:none}
.nix-toc-folded a:hover{color:var(--link)}
.nix-docs-article{min-width:0}
.nix-docs-article .nix-prose{margin-top:2rem}
.nix-section-index{margin-top:2.5rem}
.nix-section-index h2{font-size:1rem;font-family:var(--meta);font-weight:400;color:var(--muted);letter-spacing:.04em;margin:0 0 .75rem}
@media (min-width:52rem){
  .nix-docs{grid-template-columns:15rem minmax(0,1fr)}
  .nix-sidebar{display:block;position:sticky;top:4.5rem;align-self:start;max-height:calc(100vh - 6rem);overflow:auto;padding:0 .5rem 2rem 0}
  .nix-sidebar-mobile{display:none}
}
@media (min-width:76rem){
  .nix-docs{grid-template-columns:15rem minmax(0,1fr) 13rem}
  .nix-toc{display:block;position:sticky;top:4.5rem;align-self:start}
  .nix-toc-folded{display:none}
}

/* Blog and portfolio layout */
.nix-section{margin:0 0 calc(clamp(3rem,6vw,4.5rem) * var(--rhythm))}
.nix-section-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:.4rem 1rem;margin:0 0 1.25rem}
.nix-section-head h2{display:flex;align-items:baseline;gap:.6rem;margin:0;font-size:1.65rem;font-weight:800;letter-spacing:-.02em}
.nix-section-head h2 a{color:var(--text);text-decoration:none}
.nix-section-head h2 a:hover{color:var(--link)}
.nix-section-head::after{content:'';flex:1 1 4rem;order:2;border-top:1px solid var(--border);transform:translateY(-.3em)}
.nix-section-head p{order:3;margin:0;font-family:var(--meta);font-size:.8125rem;color:var(--muted)}
.nix-posts{list-style:none;margin:0;padding:0}
.nix-post-row{display:grid;grid-template-columns:9.5rem minmax(0,1fr);gap:.25rem 1.5rem;padding:calc(1.1rem * var(--rhythm)) 0;border-bottom:1px solid var(--border)}
.nix-post-row:first-child{border-top:1px solid var(--border)}
.nix-post-row time{font-family:var(--meta);font-size:.8125rem;color:var(--muted);padding-top:.3rem}
.nix-post-row h3{margin:0;font-size:1.25rem;font-weight:800;letter-spacing:-.015em;line-height:1.3}
.nix-post-row h3 a{color:var(--text);text-decoration:none}
.nix-post-row h3 a:hover{color:var(--link);text-decoration:underline}
.nix-post-row p{margin:.3rem 0 .5rem;color:var(--muted);font-size:1rem}
.nix-year{margin:calc(2.5rem * var(--rhythm)) 0 .5rem;font-family:var(--meta);font-size:.875rem;font-weight:400;color:var(--muted)}
.nix-cards{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(17rem,1fr));gap:calc(1.5rem * var(--rhythm))}
.nix-card{display:flex;flex-direction:column;height:100%;border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;background:var(--surface);color:var(--text);text-decoration:none}
.nix-card:hover{border-color:var(--accent)}
.nix-card img,.nix-card-blank{display:block;width:100%;aspect-ratio:1200/630;object-fit:cover;background:var(--code);border-bottom:1px solid var(--border)}
.nix-card-body{padding:1rem 1.15rem 1.2rem}
.nix-card h3{display:flex;align-items:baseline;gap:.5rem;margin:0;font-size:1.2rem;font-weight:800;letter-spacing:-.01em}
.nix-card p{margin:.35rem 0 0;color:var(--muted);font-size:.9375rem;line-height:1.5}
.nix-article{padding:calc(clamp(2rem,5vw,4rem) * var(--rhythm)) 0 4rem}
.nix-article-head{max-width:48rem;margin-bottom:calc(2.5rem * var(--rhythm))}
.nix-layout-blog .nix-title{font-size:clamp(2.3rem,1.4rem + 4vw,4rem);letter-spacing:-.04em}
.nix-cover{margin:0 0 2.5rem;max-width:60rem}
.nix-cover img{display:block;width:100%;border-radius:var(--radius-lg);border:1px solid var(--border)}
.nix-layout-blog .nix-prose{font-size:1.125rem;line-height:calc(1.45 + .25 * var(--rhythm))}

/* Footer */
.nix-foot{border-top:1px solid var(--border);margin-top:2rem}
.nix-foot-inner{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.75rem 2rem;max-width:84rem;margin:0 auto;padding:1.75rem var(--gutter) 2.5rem;font-size:.875rem;color:var(--muted)}
.nix-foot p{margin:0}
.nix-foot ul{display:flex;flex-wrap:wrap;gap:.5rem 1.25rem;list-style:none;margin:0;padding:0}
.nix-foot a{color:var(--muted)}
.nix-built{display:inline-flex;align-items:center;gap:.5rem;font-family:var(--meta);font-size:.8125rem;text-decoration:none}
.nix-built:hover{color:var(--text)}
.nix-404{padding:clamp(4rem,12vw,9rem) 0}

@media (max-width:40rem){
  .nix-top{position:static}
  .nix-post-row{grid-template-columns:minmax(0,1fr)}
  .nix-post-row time{padding-top:0}
  .nix-pager{grid-template-columns:minmax(0,1fr)}
  .nix-pager-next{grid-column:1}
  .nix-search input{width:min(11rem,44vw)}
  /* The navigation takes its own row and scrolls sideways instead of wrapping. */
  .nix-nav{order:3;flex-basis:100%;overflow-x:auto;scrollbar-width:thin}
  .nix-nav ul{flex-wrap:nowrap;white-space:nowrap}
  .nix-nav a{display:inline-flex;align-items:center;min-height:44px}
  .nix-chart-text{font-size:15px}
  .nix-chart-axis{font-size:18px}
}
@media (prefers-reduced-motion:no-preference){
  a,.nix-card,.nix-pager a,.nix-theme,.nix-anchor{transition:color .15s,border-color .15s,background-color .15s,opacity .15s}
}
@media print{.nix-top,.nix-sidebar,.nix-toc,.nix-foot,.nix-pager{display:none}}
${MARKS[settings.headingMark]}
`;
}

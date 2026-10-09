import mermaid from 'mermaid';

function mermaidThemeVariables() {
  const style = getComputedStyle(document.documentElement);
  const color = (token: string): string | undefined => {
    const value = style.getPropertyValue(token).trim();
    return /^#[\da-f]{6}$/iu.test(value) ? value : undefined;
  };
  const background = color('--color-bg');
  const surface = color('--color-surface');
  const text = color('--color-text');
  const accent = color('--color-accent');
  const fontFamily = style.getPropertyValue('--font-body').trim();
  return {
    darkMode: style.colorScheme === 'dark',
    background,
    primaryColor: surface,
    primaryTextColor: text,
    primaryBorderColor: accent,
    secondaryColor: background,
    secondaryTextColor: text,
    secondaryBorderColor: accent,
    tertiaryColor: surface,
    tertiaryTextColor: text,
    tertiaryBorderColor: accent,
    textColor: text,
    lineColor: text,
    arrowheadColor: text,
    actorLineColor: text,
    signalColor: text,
    signalTextColor: text,
    labelTextColor: text,
    stateLabelColor: text,
    branchLabelColor: text,
    edgeLabelBackground: background,
    relationLabelBackground: background,
    attributeBackgroundColorOdd: surface,
    attributeBackgroundColorEven: background,
    noteBkgColor: background,
    noteTextColor: text,
    noteBorderColor: accent,
    pieStrokeColor: text,
    pieOuterStrokeColor: text,
    archEdgeColor: text,
    archEdgeArrowColor: text,
    archGroupBorderColor: text,
    fontFamily: /^[\w\s,'"-]+$/u.test(fontFamily) ? fontFamily : undefined,
    fontSize: style.fontSize || undefined,
  };
}

export function mermaidThemeSnapshot(): string {
  return JSON.stringify(mermaidThemeVariables());
}

export function subscribeToMermaidTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'class', 'style'],
  });
  const media =
    typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia('(prefers-color-scheme: dark)')
      : null;
  media?.addEventListener('change', onChange);
  return () => {
    observer.disconnect();
    media?.removeEventListener('change', onChange);
  };
}

let pending = Promise.resolve();

export function renderMermaid(source: string, id: string): Promise<string> {
  // Mermaid keeps its configuration and diagram databases shared across asynchronous renders.
  const result = pending.then(async () => {
    const fontDocument: { readonly fonts?: FontFaceSet } = document;
    await fontDocument.fonts?.ready;
    const themeVariables = mermaidThemeVariables();
    mermaid.initialize({
      securityLevel: 'strict',
      startOnLoad: false,
      suppressErrorRendering: true,
      htmlLabels: false,
      secure: [
        'secure',
        'securityLevel',
        'startOnLoad',
        'suppressErrorRendering',
        'htmlLabels',
        'maxTextSize',
        'maxEdges',
      ],
      theme: 'base',
      themeVariables,
    });
    const { svg } = await mermaid.render(id, source);
    if (themeVariables.darkMode && themeVariables.lineColor !== undefined) {
      // Several Mermaid families hardcode black connectors instead of using their theme roles.
      const diagram = new DOMParser().parseFromString(svg, 'image/svg+xml');
      for (const line of diagram.querySelectorAll(
        '[stroke], marker path, marker polygon, marker polyline, marker circle',
      )) {
        for (const attribute of ['stroke', 'fill']) {
          if (attribute === 'fill' && line.closest('marker') === null) continue;
          const value = line.getAttribute(attribute);
          if (
            (attribute === 'fill' && value === null) ||
            /^(?:black|#000(?:000)?)$/iu.test(value ?? '') // design-token-exempt: matches vendor SVG colors; replacement resolves from a Nix token.
          ) {
            line.setAttribute(attribute, themeVariables.lineColor);
          }
        }
      }
      return new XMLSerializer().serializeToString(diagram.documentElement);
    }
    return svg;
  });
  pending = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

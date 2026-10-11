import { labelsFor, renderChartSvg } from '@nix/chart-render';
import { PRINT_PALETTE } from '@nix/design-tokens/print';
import type { LossSink, ViewSnapshot } from '@nix/export';
import { renderView } from '@nix/view-render';

import { coverOf, formatDate, isoDay, type SiteModel, type SiteNode } from '../site-model.js';
import { cardFacts, subtitleOf } from '../theme/facts.js';
import { escapeHtml } from './escape.js';

/**
 * A page's default view, drawn for a static page.
 *
 * **Rows are the page's children in the manifest, and only those.** Core's eligibility query
 * decided what is published; a view drawn from anything else (a bundle's `viewRows`, say) could
 * show an excluded, locked or future-dated child. Charts are the one exception, and only because
 * Core attaches a chart to the manifest solely when every child is eligible (plan decision 1.7).
 *
 * List and gallery views become index pages, a board becomes the `@nix/view-render` drawing, a
 * chart becomes `@nix/chart-render`'s SVG over a table, and every other kind a list of titles.
 */

export function defaultView(node: SiteNode): ViewSnapshot | null {
  const views = node.page.views;
  if (views === null || views.views.length === 0) {
    return null;
  }
  return views.views.find((view) => view.id === views.default) ?? views.views[0] ?? null;
}

function titleList(children: readonly SiteNode[]): string {
  return `<ul class="nix-index">${children
    .map(
      (child) =>
        `<li><a href="${escapeHtml(child.page.path)}"><span class="nix-index-title">${escapeHtml(child.page.title)}</span>${
          child.page.publishedAt === null
            ? ''
            : `<time datetime="${isoDay(child.page.publishedAt)}">${formatDate(child.page.publishedAt)}</time>`
        }</a></li>`,
    )
    .join('')}</ul>`;
}

function gallery(model: SiteModel, view: ViewSnapshot, children: readonly SiteNode[]): string {
  return `<ul class="nix-gallery">${children
    .map((child) => {
      const cover = coverOf(model, child, view.coverProperty);
      const image =
        cover === null
          ? '<span class="nix-gallery-blank" aria-hidden="true"></span>'
          : `<img src="${escapeHtml(cover.url)}" alt=""${cover.width !== null && cover.height !== null ? ` width="${String(cover.width)}" height="${String(cover.height)}"` : ''} loading="lazy" decoding="async">`;
      const subtitle = subtitleOf(child);
      return `<li><a href="${escapeHtml(child.page.path)}">${image}<span class="nix-gallery-title">${escapeHtml(child.page.title)}</span>${subtitle === null ? '' : `<span class="nix-gallery-subtitle">${escapeHtml(subtitle)}</span>`}${cardFacts(model, child)}</a></li>`;
    })
    .join('')}</ul>`;
}

function chart(node: SiteNode, view: ViewSnapshot, loss: LossSink): string {
  // The chart counts the children; the list under it is how a reader reaches them.
  const pages = node.children.length === 0 ? '' : titleList(node.children);
  const data = node.page.chart;
  if (data === null) {
    loss.note(
      'views-not-rendered',
      'A chart was not published because some of what it counts is not published.',
    );
    return `<p class="nix-notice">This chart is not published.</p>${pages}`;
  }
  const labels = labelsFor(node.page.schema?.properties ?? [], 'Unset');
  const drawn = renderChartSvg(data, {
    labels,
    idPrefix: `chart-${view.id.replace(/[^a-zA-Z0-9-]/g, '')}`,
    locale: 'en-GB',
    caption: view.name,
  });
  const legend =
    drawn.legend.length === 0
      ? ''
      : `<ul class="nix-chart-legend">${drawn.legend.map((entry) => `<li>${entry.swatch}<span>${escapeHtml(entry.label)}</span></li>`).join('')}</ul>`;
  const table = `<div class="nix-table" role="region" aria-label="${escapeHtml(drawn.table.caption)}" tabindex="0"><table><caption>${escapeHtml(drawn.table.caption)}</caption><thead><tr><th scope="col">${escapeHtml(drawn.table.rowHeader)}</th>${drawn.table.columns.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${drawn.table.rows
    .map(
      (row) =>
        `<tr><th scope="row">${escapeHtml(row.label)}</th>${row.values.map((value) => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`,
    )
    .join('')}</tbody></table></div>`;
  const notes = drawn.notes.map((note) => `<p class="nix-notice">${escapeHtml(note)}</p>`).join('');
  return `<figure class="nix-chart-figure"><figcaption>${escapeHtml(view.name)}</figcaption>${legend}${drawn.svg}${notes}${table}</figure>${pages}`;
}

function board(node: SiteNode, view: ViewSnapshot, children: readonly SiteNode[]): string {
  const drawn = renderView({
    view,
    rows: children.map((child) => ({
      id: child.page.itemId,
      title: child.page.title,
      properties: child.page.properties,
    })),
    schema: node.page.schema,
    palette: PRINT_PALETTE,
    // Drawn in print colours on a paper-coloured panel; narrower than the column so its text scales up.
    width: 600,
  });
  return `<figure class="nix-board"><figcaption>${escapeHtml(view.name)}</figcaption><div class="nix-board-paper" role="img" aria-label="${escapeHtml(`${view.name}: ${children.map((child) => child.page.title).join(', ')}`)}">${drawn.svg}</div>${titleList(children)}</figure>`;
}

export function renderViewHtml(model: SiteModel, node: SiteNode, loss: LossSink): string {
  const view = defaultView(node);
  const children = node.children;
  if (view === null) {
    return '';
  }
  switch (view.kind) {
    case 'list':
      return children.length === 0 ? '' : titleList(children);
    case 'gallery':
      return children.length === 0 ? '' : gallery(model, view, children);
    case 'board':
      return board(node, view, children);
    case 'chart':
      return chart(node, view, loss);
    default:
      loss.note('views-as-image', `A ${view.kind} view was published as a list of its pages.`);
      return children.length === 0 ? '' : titleList(children);
  }
}

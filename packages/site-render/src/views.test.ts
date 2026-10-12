import { describe, expect, it } from 'vitest';

import { renderSite } from './render.js';
import { aSite, fileText, listViews } from './site.test-helper.js';

describe('views on a site', () => {
  it('draws list rows from the manifest children, in manifest order', () => {
    const html = fileText(renderSite(aSite()).files, 'lists/index.html');
    expect(html).toContain('<ul class="nix-index"><li><a href="/lists/one/">');
  });

  it('draws a board from the manifest children and never a hidden row', () => {
    const site = aSite();
    const pages = site.pages.map((page) =>
      page.itemId === 'lists' ? { ...page, views: listViews('board') } : page,
    );
    const html = fileText(renderSite({ ...site, pages }).files, 'lists/index.html');
    expect(html).toContain('<svg');
    expect(html).toContain('List one');
  });

  it('refuses to draw a chart Core did not attach', () => {
    const site = aSite();
    const pages = site.pages.map((page) =>
      page.itemId === 'lists' ? { ...page, views: listViews('chart'), chart: null } : page,
    );
    const rendered = renderSite({ ...site, pages });
    expect(fileText(rendered.files, 'lists/index.html')).toContain('This chart is not published.');
    expect(rendered.loss.map((entry) => entry.kind)).toContain('views-not-rendered');
  });

  it('lists a view kind it cannot draw', () => {
    const site = aSite();
    const pages = site.pages.map((page) =>
      page.itemId === 'lists' ? { ...page, views: listViews('calendar') } : page,
    );
    const rendered = renderSite({ ...site, pages });
    expect(fileText(rendered.files, 'lists/index.html')).toContain('List one');
    expect(rendered.loss.map((entry) => entry.kind)).toContain('views-as-image');
  });
});

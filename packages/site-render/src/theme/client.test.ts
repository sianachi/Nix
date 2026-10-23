// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CLIENT_JS } from './client.js';

const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());

function load(html: string): void {
  document.body.innerHTML = html;
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  // The script is shipped as a string and run as-is, as the page does.
  window.eval(CLIENT_JS);
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the site script', () => {
  beforeEach(() => {
    writeText.mockClear();
  });

  it('adds a copy button to each code block that copies its text', async () => {
    load('<pre class="nix-code"><code>echo <span>hi</span></code></pre>');
    const button = document.querySelector<HTMLButtonElement>('.nix-copy');
    expect(button?.textContent).toBe('Copy');

    button?.click();
    await settle();

    expect(writeText).toHaveBeenCalledWith('echo hi');
    expect(button?.textContent).toBe('Copied');
    expect(document.querySelector('[aria-live]')?.textContent).toBe('Copied');
  });

  it('copies the full link when a section link is clicked', async () => {
    load('<h2 id="files">Files<a class="nix-anchor" href="#files">#</a></h2>');
    const anchor = document.querySelector<HTMLAnchorElement>('.nix-anchor');

    anchor?.click();
    await settle();

    expect(writeText).toHaveBeenCalledWith(`${location.origin}${location.pathname}#files`);
    expect(anchor?.textContent).toBe('Link copied');
  });
});

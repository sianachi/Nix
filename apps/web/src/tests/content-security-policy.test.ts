// @vitest-environment node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { OIDC_ORIGIN_TOKEN, substituteOidcOrigin } from '../../vite.config';

// The application's content security policy is written twice - as a meta tag in index.html, so it
// holds on the Vite dev server and any static preview, and as a header in deploy/Caddyfile, so it
// holds in front of the built bundle. Two copies of one policy drift, and CSP drift is silent
// until a user hits the feature it broke: a blocked inline style attribute is an invisible layout
// collapse, a blocked issuer origin is a sign-in that fails at the first click.
//
// So this pins both. Every relaxation asserted below is one a reviewer found the strict policy had
// broken, and each is named so removing it fails here with the feature it would break, rather than
// in a browser weeks later.

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = join(appDir, '..', '..');

const indexHtml = readFileSync(join(appDir, 'index.html'), 'utf8');
const caddyfile = readFileSync(join(repoRoot, 'deploy', 'Caddyfile'), 'utf8');

/** The first capture of a match, or a failure naming what was being looked for. */
function captured(pattern: RegExp, text: string, what: string): string {
  const value = pattern.exec(text)?.[1];

  if (value === undefined) {
    throw new Error(`no ${what}`);
  }

  return value;
}

/** The policy string of the meta tag, before any substitution. */
function metaPolicy(html: string): string {
  return captured(
    /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
    html,
    'Content-Security-Policy meta tag in index.html',
  );
}

/** The policy string of the Caddy header. */
function caddyPolicy(text: string): string {
  return captured(
    /^\s*Content-Security-Policy "([^"]+)"/m,
    text,
    'Content-Security-Policy header in deploy/Caddyfile',
  );
}

/** A policy as directive name to source expressions, so assertions name one directive at a time. */
function directives(policy: string): ReadonlyMap<string, readonly string[]> {
  return new Map(
    policy
      .split(';')
      .map((directive) => directive.trim())
      .filter((directive) => directive.length > 0)
      .map((directive) => {
        const [name = directive, ...sources] = directive.split(/\s+/);

        return [name, sources] as const;
      }),
  );
}

const meta = directives(metaPolicy(indexHtml));
const caddy = directives(caddyPolicy(caddyfile));

describe('the content security policy', () => {
  it('allows inline styles, because runtime geometry travels in style attributes', () => {
    // The calendar's hour rows and timed-item offsets, the sheet grid's row positions, pane shares
    // and sidebar width, and the caret-anchored slash and reference menus all set a style
    // attribute, which style-src governs. Vite's dev server also injects styles as inline <style>
    // elements, so without this the dev server serves the app unstyled.
    expect(meta.get('style-src')).toContain("'unsafe-inline'");
    expect(caddy.get('style-src')).toContain("'unsafe-inline'");
  });

  it('allows http and https images, because covers are arbitrary third-party addresses', () => {
    // The server's PropertyValidator accepts both schemes, and so does the image property input.
    // A policy that accepts only https makes the picker report a correct address as broken.
    for (const scheme of ['http:', 'https:']) {
      expect(meta.get('img-src')).toContain(scheme);
      expect(caddy.get('img-src')).toContain(scheme);
    }
  });

  it('lets the identity provider be reached and framed, which sign-in and every reload need', () => {
    // oidc-client-ts fetches discovery, posts the code exchange and loads userinfo (connect-src),
    // and drives a hidden iframe against the authorize endpoint for silent renew (frame-src).
    // Tokens are held in memory only, so a reload without that renew is a signed-out session.
    for (const directive of ['connect-src', 'frame-src']) {
      expect(meta.get(directive)).toEqual(["'self'", OIDC_ORIGIN_TOKEN]);
      expect(caddy.get(directive)).toEqual(["'self'", '{env.NIX_OIDC_ISSUER}']);
    }
  });

  it('keeps everything else closed', () => {
    for (const policy of [meta, caddy]) {
      expect(policy.get('default-src')).toEqual(["'self'"]);
      expect(policy.get('object-src')).toEqual(["'none'"]);
      expect(policy.get('base-uri')).toEqual(["'self'"]);
      expect(policy.get('form-action')).toEqual(["'self'"]);
      expect(policy.get('font-src')).toEqual(["'self'"]);
      expect(policy.get('script-src')?.[0]).toBe("'self'");
    }

    // Only a header can carry frame-ancestors, which is the one directive the two do not share.
    expect(caddy.get('frame-ancestors')).toEqual(["'none'"]);
    expect(meta.has('frame-ancestors')).toBe(false);
  });

  it('is the same policy in the document and in front of the deployed bundle', () => {
    const shared = (policy: ReadonlyMap<string, readonly string[]>) =>
      [...policy]
        .filter(([name]) => name !== 'frame-ancestors')
        .map(([name, sources]) => [
          name,
          // The issuer origin is the one value spelled differently: a build-time substitution in
          // the document, an environment placeholder in Caddy. Everything else must match.
          sources.map((source) =>
            source === OIDC_ORIGIN_TOKEN || source === '{env.NIX_OIDC_ISSUER}'
              ? '<issuer>'
              : source,
          ),
        ]);

    expect(shared(caddy)).toEqual(shared(meta));
  });

  it('hashes the inline theme script it allows', () => {
    // script-src carries no 'unsafe-inline'; the theme script runs on a hash of its exact bytes,
    // so editing that script without recomputing the hash would leave the first paint unthemed.
    // The last inline <script> is the theme script: the comment above it in index.html contains an
    // earlier <script> spelling, which a first match would find instead.
    const scripts = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((match) => match[1])
      .filter((body): body is string => body !== undefined);
    const theme = scripts.at(-1);

    expect(theme).toBeDefined();

    const expected = `'sha256-${createHash('sha256')
      .update(theme ?? '')
      .digest('base64')}'`;

    expect(meta.get('script-src')).toContain(expected);
    expect(caddy.get('script-src')).toContain(expected);
  });
});

describe('the issuer origin substitution', () => {
  it('names the issuer origin, dropping any path the issuer URL carries', () => {
    const substituted = substituteOidcOrigin(indexHtml, 'https://id.example.com/oauth/v2');

    expect(substituted).not.toContain(OIDC_ORIGIN_TOKEN);
    expect(directives(metaPolicy(substituted)).get('connect-src')).toEqual([
      "'self'",
      'https://id.example.com',
    ]);
    expect(directives(metaPolicy(substituted)).get('frame-src')).toEqual([
      "'self'",
      'https://id.example.com',
    ]);
  });

  it('keeps a port, which every development issuer has', () => {
    const substituted = substituteOidcOrigin(indexHtml, 'http://localhost:8300');

    expect(directives(metaPolicy(substituted)).get('connect-src')).toEqual([
      "'self'",
      'http://localhost:8300',
    ]);
  });

  it('falls back to self alone when no issuer is configured', () => {
    // An unset or unparseable issuer must leave a valid policy rather than a literal placeholder,
    // which a browser would read as a source expression it does not understand.
    for (const issuer of [undefined, '', 'not-a-url']) {
      const substituted = substituteOidcOrigin(indexHtml, issuer);

      expect(substituted).not.toContain(OIDC_ORIGIN_TOKEN);
      expect(directives(metaPolicy(substituted)).get('connect-src')).toEqual(["'self'"]);
      expect(directives(metaPolicy(substituted)).get('frame-src')).toEqual(["'self'"]);
    }
  });
});

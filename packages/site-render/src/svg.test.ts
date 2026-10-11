// design-token-exempt-file: vendor SVG fixtures carry their own literal colours as test input.
import { describe, expect, it } from 'vitest';

import { MAX_DIAGRAM_BYTES, MAX_USE_ELEMENTS, sanitizeSvg, UnsafeSvg } from './svg.js';

const HASH = 'a'.repeat(64);
const wrap = (inner: string, attrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120.5 40"${attrs}>${inner}</svg>`;

describe('sanitizeSvg', () => {
  it('keeps a plain drawing and gives it an intrinsic size', () => {
    const out = sanitizeSvg(
      wrap(
        '<style>#d .node rect{fill:#eee}</style><g class="node"><rect x="1" y="2" width="3" height="4"/><text x="5">A &amp; B</text></g>',
        ' id="d" width="100%" style="max-width: 120px;"',
      ),
      HASH,
    );
    expect(out.width).toBe(121);
    expect(out.height).toBe(40);
    expect(out.sourceSha256).toBe(HASH);
    expect(out.svg).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120.5 40" id="d" width="121" height="40" data-nix-source-sha256="${HASH}"><style>#d .node rect{fill:#eee}</style><g class="node"><rect x="1" y="2" width="3" height="4"></rect><text x="5">A &amp; B</text></g></svg>`,
    );
    // Sanitising its own output changes nothing and keeps the stamp.
    expect(sanitizeSvg(out.svg).svg).toBe(out.svg);
  });

  it('drops script elements, in any case and namespace', () => {
    const { svg } = sanitizeSvg(
      wrap('<script>alert(1)</script><SCRIPT>alert(2)</SCRIPT><svg:script>x</svg:script><g/>'),
    );
    expect(svg).not.toMatch(/script|alert/i);
    expect(svg).toContain('<g></g>');
  });

  it('drops event handlers', () => {
    const { svg } = sanitizeSvg(
      wrap('<rect onclick="alert(1)" ONMOUSEOVER="x()" width="1"/>', ' onload="alert(1)"'),
    );
    expect(svg).not.toMatch(/on(load|click|mouseover)|alert/i);
    expect(svg).toContain('<rect width="1"></rect>');
  });

  it('drops foreignObject and its HTML', () => {
    const { svg } = sanitizeSvg(
      wrap(
        '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></div></foreignObject><text>kept</text>',
      ),
    );
    expect(svg).not.toMatch(/foreignObject|div|img|onerror/);
    expect(svg).toContain('<text>kept</text>');
  });

  it('allows only same-picture references', () => {
    const { svg } = sanitizeSvg(
      wrap(
        '<a xlink:href="javascript:alert(1)"><text>link text</text></a>' +
          '<g id="node"/><use xlink:href="#node"/><use href="https://evil.test/x.svg#a"/>' +
          '<image href="https://evil.test/track.png"/><image xlink:href="data:image/png;base64,AAAA"/>' +
          '<path marker-end="url(#arrow)" fill="url(https://evil.test/p)"/>',
      ),
    );
    expect(svg).not.toMatch(/javascript|evil|data:|<image|<a /);
    expect(svg).toContain('<text>link text</text>');
    expect(svg).toContain('<use href="#node"></use>');
    // A use with no same-picture target is dropped whole.
    expect(svg.match(/<use /g)).toHaveLength(1);
    expect(svg).toContain('<path marker-end="url(#arrow)"></path>');
  });

  it('drops CSS that loads anything', () => {
    const { svg } = sanitizeSvg(
      wrap(
        '<style>@import url(https://evil.test/a.css);</style>' +
          '<style>.a{background:url(https://evil.test/b.png)}</style>' +
          '<style>.b{background:u\\72l(https://evil.test/c.png)}</style>' +
          '<style>.ok{fill:url(#grad)}</style>' +
          '<rect style="fill:url(https://evil.test/d)"/><rect style="fill:red"/>',
      ),
    );
    expect(svg).not.toMatch(/evil|@import/);
    expect(svg).toContain('<style>.ok{fill:url(#grad)}</style>');
    expect(svg).toContain('<rect></rect><rect style="fill:red"></rect>');
  });

  it('refuses DOCTYPEs and entity declarations, so nothing expands', () => {
    const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><svg xmlns="http://www.w3.org/2000/svg"><text>&lol2;</text></svg>`;
    expect(() => sanitizeSvg(laughs)).toThrow(UnsafeSvg);
    const external = `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg><text>&x;</text></svg>`;
    expect(() => sanitizeSvg(external)).toThrow(UnsafeSvg);
    expect(() => sanitizeSvg(wrap('<text>&nbsp;</text>'))).toThrow(UnsafeSvg);
  });

  it('decodes character references and re-escapes them', () => {
    const { svg } = sanitizeSvg(wrap('<text title="x">&#60;b&#x3e; &lt;/b&gt;</text>'));
    expect(svg).toContain('<text>&lt;b&gt; &lt;/b&gt;</text>');
  });

  it('cannot be broken out of by attribute values', () => {
    const { svg } = sanitizeSvg(wrap(`<rect class='a" onload="alert(1)'/>`));
    expect(svg).toContain('<rect class="a&quot; onload=&quot;alert(1)"></rect>');
  });

  it('refuses malformed and non-SVG input', () => {
    for (const bad of [
      '<html><body/></html>',
      '<svg><g></svg>',
      '<svg><rect x=1/></svg>',
      '<svg></svg><svg></svg>',
      '<svg><![CDATA[x]]',
      'not xml',
      '<svg a="<b>"></svg>',
      '<svg>&</svg>',
    ]) {
      expect(() => sanitizeSvg(bad), bad).toThrow(UnsafeSvg);
    }
  });

  it('refuses a picture over the size cap', () => {
    expect(() => sanitizeSvg(wrap(' '.repeat(MAX_DIAGRAM_BYTES)))).toThrow(UnsafeSvg);
  });

  it('ignores a stamp that is not a digest', () => {
    expect(sanitizeSvg(wrap('', ' data-nix-source-sha256="nope"')).sourceSha256).toBeNull();
  });

  it('drops every CSS function that can fetch, in <style> and style=', () => {
    for (const fetch of [
      "image-set('https://evil.test/a.png' 1x)",
      "-webkit-image-set('https://evil.test/a.png' 1x)",
      "image('https://evil.test/a.png')",
      "src('https://evil.test/a.png')",
      "cross-fade(url(#a), 'https://evil.test/b.png', 50%)",
      'element(#a)',
    ]) {
      const { svg } = sanitizeSvg(
        wrap(`<style>.x{background:${fetch}}</style><rect style="fill:${fetch}"/>`),
      );
      expect(svg, fetch).not.toMatch(/evil|<style|style=|element\(/);
    }
  });

  it('refuses characters that XML cannot carry, raw or referenced', () => {
    for (const bad of [
      wrap('<text>&#1;</text>'),
      wrap('<text>&#xFFFE;</text>'),
      wrap('<text>&#xD800;</text>'),
      wrap('<text>\u0001</text>'),
      wrap('<text>\u001B[31m</text>'),
      wrap('<rect class="\u0008"/>'),
      wrap('<text>\uD800</text>'),
    ]) {
      expect(() => sanitizeSvg(bad), JSON.stringify(bad)).toThrow(UnsafeSvg);
    }
    expect(sanitizeSvg(wrap('<text>tab\there &#x1F600;</text>')).svg).toContain(
      'tab\there \u{1F600}',
    );
  });

  it('writes each attribute once after folding xlink:href', () => {
    const { svg } = sanitizeSvg(
      wrap('<g id="a"/><g id="b"/><use href="#a" xlink:href="#b" class="x" class="y"/>'),
    );
    expect(svg).toContain('<use href="#a" class="x"></use>');
  });

  it('bounds <use>: one level of reference, and a fixed count', () => {
    const nested = sanitizeSvg(
      wrap(
        '<g id="leaf"><rect/></g>' +
          '<g id="l1"><use href="#leaf"/><use href="#leaf"/></g>' +
          '<g id="l2"><use href="#l1"/><use href="#l1"/></g>' +
          '<use href="#l2"/><use href="#missing"/><use href="#self" id="self"/>',
      ),
    ).svg;
    // Only the two uses that point at plain drawings survive.
    expect(nested.match(/<use /g)).toHaveLength(2);
    expect(nested).not.toMatch(/#l1|#l2|#missing|#self/);

    const many = wrap(`<g id="a"/>${'<use href="#a"/>'.repeat(MAX_USE_ELEMENTS + 1)}`);
    expect(() => sanitizeSvg(many)).toThrow(UnsafeSvg);
    const enough = wrap(`<g id="a"/>${'<use href="#a"/>'.repeat(MAX_USE_ELEMENTS)}`);
    expect(sanitizeSvg(enough).svg.match(/<use /g)).toHaveLength(MAX_USE_ELEMENTS);
  });

  it('is idempotent over the adversarial corpus', () => {
    const corpus = [
      wrap('<script>alert(1)</script><SCRIPT>x</SCRIPT><g/>', ' onload="alert(1)" id="d"'),
      wrap(
        '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject><text>kept</text>',
      ),
      wrap(
        '<a xlink:href="javascript:alert(1)"><text>t</text></a><use xlink:href="#n"/><g id="n"/>',
      ),
      wrap(
        '<image href="https://evil.test/x.png"/><path marker-end="url(#m)" fill="url(https://evil.test/p)"/>',
      ),
      wrap(
        '<style>.a > .b{fill:url(#g)} .c{background:image-set("x" 1x)}</style><rect style="fill:red"/>',
      ),
      wrap(`<rect class='a" onload="x'/><text>&#60;b&#x3e; &lt;&amp;&gt; &quot;</text>`),
      wrap('<use href="#a" xlink:href="#b"/><g id="a"/><g id="b"/>'),
      wrap('<![CDATA[<raw & text>]]><text xml:space="preserve">  two  spaces  </text>'),
      wrap('<g id="x"><use href="#x"/></g><use href="#x"/>', ` data-nix-source-sha256="${HASH}"`),
    ];
    for (const input of corpus) {
      const once = sanitizeSvg(input).svg;
      expect(sanitizeSvg(once).svg, input).toBe(once);
    }
  });
});

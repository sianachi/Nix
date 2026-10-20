import { describe, expect, it } from 'vitest';

import { highlightCode } from './html/highlight.js';

describe('openui-lang highlighting', () => {
  const html = highlightCode(
    '// totals\nroot = Stack([Text("a <b>", "title"), n])\nn = Stat("N", @Round($x + 1.5, 0))\n$x = null',
    'openui-lang',
  );

  it('marks statements, components, variables, builtins, literals, numbers and comments', () => {
    expect(html).toContain('<span class="hljs-comment">// totals</span>');
    expect(html).toContain('<span class="hljs-section">root</span>');
    expect(html).toContain('<span class="hljs-title">Stack</span>');
    expect(html).toContain('<span class="hljs-variable">$x</span>');
    expect(html).toContain('<span class="hljs-built_in">@Round</span>');
    expect(html).toContain('<span class="hljs-number">1.5</span>');
    expect(html).toContain('<span class="hljs-literal">null</span>');
  });

  it('keeps the program text and escapes it', () => {
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>');
  });
});

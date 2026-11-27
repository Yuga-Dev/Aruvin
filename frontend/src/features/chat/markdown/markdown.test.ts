/**
 * ============================================================================
 * FILE: markdown.test.ts
 * LOCATION: frontend/src/features/chat/markdown/markdown.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify Markdown tokenization, URL sanitizing, and XSS disarming.
 *
 * ROLE IN PROJECT:
 *    Ensures progressive assistant rendering stays safe without a browser DOM
 *    or HTML sanitizer dependency.
 *
 * KEY COMPONENTS:
 *    - sanitizeUrl tests: Protocol whitelist and dangerous-scheme rejection.
 *    - parseMarkdown tests: Headings, fences, lists, quotes, raw HTML text.
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './parse-markdown.ts';
import { SafeMarkdown } from './safe-markdown.tsx';
import { isSafeHttpsUrl, sanitizeUrl, sanitizeWebSourceUrl } from './sanitize-url.ts';

describe('sanitizeUrl', () => {
  it('allows http, https, and mailto protocols', () => {
    expect(sanitizeUrl('https://example.com/test')).toBe('https://example.com/test');
    expect(sanitizeUrl('http://insecure.org')).toBe('http://insecure.org');
    expect(sanitizeUrl('mailto:peter@example.com')).toBe('mailto:peter@example.com');
  });

  it('disarms dangerous protocols: javascript, data, vbscript, and file', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBe('');
    expect(sanitizeUrl('JAVASCRIPT:alert(1)')).toBe('');
    expect(sanitizeUrl('data:text/html,<script>alert(1)</script>')).toBe('');
    expect(sanitizeUrl('vbscript:msgbox("evil")')).toBe('');
    expect(sanitizeUrl('file:///etc/passwd')).toBe('');
  });

  it('allows safe relative paths', () => {
    expect(sanitizeUrl('/docs/quickstart')).toBe('/docs/quickstart');
    expect(sanitizeUrl('#heading-1')).toBe('#heading-1');
  });
});

describe('sanitizeWebSourceUrl and isSafeHttpsUrl', () => {
  it('accepts valid absolute http and https source URLs within byte limits', () => {
    expect(sanitizeWebSourceUrl('https://example.com/docs?q=1#top')).toBe(
      'https://example.com/docs?q=1#top',
    );
    expect(sanitizeWebSourceUrl('http://news.example.org/item')).toBe(
      'http://news.example.org/item',
    );
    expect(isSafeHttpsUrl('https://agent.tinyfish.ai')).toBe(true);
  });

  it('rejects mailto, relative paths, hashes, credentials, whitespace, dangerous schemes, and oversized URLs', () => {
    for (const unsafe of [
      '',
      '   ',
      ' https://example.com/',
      'https://example.com/ ',
      'https://example.com/a\nb',
      'mailto:peter@example.com',
      '/docs/quickstart',
      '#heading-1',
      '//evil.example.com/phish',
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://example.com/123',
      'ftp://example.com/file',
      'https://user:pass@example.com/',
      `https://example.com/${'a'.repeat(3000)}`,
    ]) {
      expect(sanitizeWebSourceUrl(unsafe)).toBe('');
      expect(isSafeHttpsUrl(unsafe)).toBe(false);
    }
    expect(isSafeHttpsUrl('http://example.com/oauth')).toBe(false);
  });
});

describe('parseMarkdown', () => {
  it('parses headings correctly', () => {
    const tokens = parseMarkdown('# Heading 1\n## Heading 2\n### Heading 3');
    expect(tokens).toEqual([
      { type: 'heading', level: 1, text: 'Heading 1' },
      { type: 'heading', level: 2, text: 'Heading 2' },
      { type: 'heading', level: 3, text: 'Heading 3' },
    ]);
  });

  it('parses closed and unclosed (streaming) fenced code blocks', () => {
    const closed = parseMarkdown('```typescript\nconst x = 1;\n```');
    expect(closed).toEqual([
      { type: 'code_block', lang: 'typescript', code: 'const x = 1;' },
    ]);

    const unclosed = parseMarkdown('```python\ndef test():\n    return 42');
    expect(unclosed).toEqual([
      { type: 'code_block', lang: 'python', code: 'def test():\n    return 42' },
    ]);
  });

  it('parses inline formatting: bold, italic, inline code, and links', () => {
    const text = 'Here is **bold**, *italic*, `code`, and [Link](https://google.com)';
    const tokens = parseMarkdown(text);
    expect(tokens[0]?.type).toBe('paragraph');
  });

  it('parses blockquotes and bullet lists', () => {
    const content = '> A wise quote\n\n- Item 1\n- Item 2\n\n1. First\n2. Second';
    const tokens = parseMarkdown(content);
    expect(tokens.some((t) => t.type === 'blockquote')).toBe(true);
    expect(tokens.some((t) => t.type === 'bullet_list')).toBe(true);
    expect(tokens.some((t) => t.type === 'ordered_list')).toBe(true);
  });

  it('treats raw HTML as plain paragraph text', () => {
    const tokens = parseMarkdown('<script>alert(1)</script>');
    expect(tokens).toEqual([{ type: 'paragraph', text: '<script>alert(1)</script>' }]);
  });

  it('parses single-line, multi-line, and streaming math blocks', () => {
    const multi = parseMarkdown(
      '\\[\n\n\\sin(\\theta)=\\frac35,\\qquad\n\n\\cos(\\theta)=\\frac45\n\n\\]',
    );
    expect(multi).toEqual([
      {
        type: 'math_block',
        expression: '\\sin(\\theta)=\\frac35,\\qquad\n\\cos(\\theta)=\\frac45',
      },
    ]);

    const streaming = parseMarkdown('\\[\n\\tan(\\theta)=\\frac34');
    expect(streaming).toEqual([
      { type: 'math_block', expression: '\\tan(\\theta)=\\frac34' },
    ]);
  });

  it('renders inline and block LaTeX mathematical symbols and fractions in SafeMarkdown', () => {
    const sample = [
      'For an angle \\( \\theta \\), label the sides:',
      '- **Sine:** \\(\\sin(\\theta)=\\dfrac{\\text{opposite}}{\\text{hypotenuse}}\\)',
      '\\[',
      '\\sin(\\theta)=\\frac35,\\qquad',
      '\\cos(\\theta)=\\frac45,\\qquad',
      '\\tan(\\theta)=\\frac34',
      '\\]',
    ].join('\n');

    const html = renderToStaticMarkup(createElement(SafeMarkdown, { content: sample }));
    expect(html).toContain('θ');
    expect(html).toContain('class="aurvin-math-fn">sin</span>');
    expect(html).toContain('class="aurvin-math-text">opposite</span>');
    expect(html).toContain('class="aurvin-math-text">hypotenuse</span>');
    expect(html).toContain('class="aurvin-math-frac"');
    expect(html).toContain('class="aurvin-math-block"');
    expect(html).not.toContain('\\(');
    expect(html).not.toContain('\\[');
    expect(html).not.toContain('\\theta');
    expect(html).not.toContain('\\dfrac');
    expect(html).not.toContain('\\frac35');
  });
});

describe('SafeMarkdown link presentation', () => {
  it('renders a labeled markdown link and hides the raw URL', () => {
    const html = renderToStaticMarkup(createElement(SafeMarkdown, {
      content: 'See [Bible Gateway](https://biblegateway.com/passage?search=1%20Peter%203:5&version=NRSV).',
    }));
    expect(html).toContain('href="https://biblegateway.com/passage?search=1%20Peter%203:5&amp;version=NRSV"');
    expect(html).toMatch(/<a[^>]*class="aurvin-link"[^>]*>Bible Gateway<\/a>/);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('turns a Label: URL list item into a clickable word instead of a bare URL', () => {
    const html = renderToStaticMarkup(createElement(SafeMarkdown, {
      content: '- Bible Gateway: https://biblegateway.com/passage?search=1%20Peter%203:5&version=NRSV',
    }));
    expect(html).toMatch(/<a[^>]*class="aurvin-link"[^>]*>Bible Gateway<\/a>/);
    expect(html).toContain('href="https://biblegateway.com/passage?search=1%20Peter%203:5&amp;version=NRSV"');
    expect(html).not.toMatch(/Bible Gateway:\s*https?:/);
  });

  it('autolinks a bare URL as the hostname, not the full address', () => {
    const html = renderToStaticMarkup(createElement(SafeMarkdown, {
      content: 'Read more at https://www.example.com/path?q=1.',
    }));
    expect(html).toMatch(/<a[^>]*class="aurvin-link"[^>]*>example.com<\/a>/);
    expect(html).toContain('href="https://www.example.com/path?q=1"');
    expect(html).toContain('.</p>');
  });

  it('does not autolink URLs inside code or javascript markdown hrefs', () => {
    const coded = renderToStaticMarkup(createElement(SafeMarkdown, {
      content: 'Use `https://example.com/secret` in the request.',
    }));
    expect(coded).toContain('<code>https://example.com/secret</code>');
    expect(coded).not.toContain('<a');

    const unsafe = renderToStaticMarkup(createElement(SafeMarkdown, {
      content: '[secret](javascript:alert(1))',
    }));
    expect(unsafe.toLowerCase()).not.toContain('javascript:');
    expect(unsafe).not.toContain('href=');
  });

  it('starts the post-search answer in a new paragraph when a blank line is present', () => {
    const html = renderToStaticMarkup(createElement(SafeMarkdown, {
      content: 'Let me look up the NRSV text for 1 Peter 3:5.\n\nHere is 1 Peter 3:5 from the NRSV.',
    }));
    expect(html).toContain('</p><p>');
    expect(html).toContain('1 Peter 3:5.');
    expect(html).toContain('Here is 1 Peter 3:5 from the NRSV.');
    expect(html).not.toContain('3:5.Here');
  });
});

describe('GFM tables', () => {
  const table = '| Name | Qty | Note |\n| :--- | ---: | :---: |\n| **Apple** | 3 | a \\| b |\n| Pear | 1 |';

  it('parses header, alignment, escaped pipes, and pads ragged rows', () => {
    expect(parseMarkdown(table)).toEqual([{
      type: 'table',
      align: ['left', 'right', 'center'],
      header: ['Name', 'Qty', 'Note'],
      rows: [['**Apple**', '3', 'a | b'], ['Pear', '1', '']],
    }]);
    const truncated = parseMarkdown('a | b\n-|-\n1 | 2 | 3');
    expect(truncated[0]).toMatchObject({ type: 'table', rows: [['1', '2']] });
  });

  it('ends at a blank line and leaves a lone pipe line as a paragraph', () => {
    const tokens = parseMarkdown('| a |\n|---|\n| 1 |\n\nafter');
    expect(tokens.map((t) => t.type)).toEqual(['table', 'paragraph']);
    expect(parseMarkdown('| a | b |')).toEqual([{ type: 'paragraph', text: '| a | b |' }]);
  });

  it('renders semantic markup in a scroll wrapper with safe inline cells', () => {
    const html = renderToStaticMarkup(createElement(SafeMarkdown, {
      content: `${table}\n| \`x\` | [ok](https://example.com) [bad](javascript:alert(1)) | <b>raw</b> |`,
    }));
    expect(html).toContain('class="aurvin-table-wrap"');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('<th scope="col" style="text-align:right">Qty</th>');
    expect(html).toContain('<strong>Apple</strong>');
    expect(html).toContain('<code>x</code>');
    expect(html).toContain('href="https://example.com"');
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(html).toContain('&lt;b&gt;raw&lt;/b&gt;');
  });
});

describe('nested lists', () => {
  it('nests by 2 spaces, 4 spaces, or tab and mixes list types', () => {
    for (const indent of ['  ', '    ', '\t']) {
      const [list] = parseMarkdown(`- a\n${indent}1. b\n${indent}2. c\n- d`);
      expect(list).toMatchObject({ type: 'bullet_list' });
      const items = (list as Extract<ReturnType<typeof parseMarkdown>[number], { type: 'bullet_list' }>).items;
      expect(items.map((i) => i.text)).toEqual(['a', 'd']);
      expect(items[0]?.children[0]).toMatchObject({
        type: 'ordered_list', items: [{ text: 'b' }, { text: 'c' }],
      });
    }
  });

  it('keeps the start number, loose items, continuation paragraphs, and code', () => {
    const tokens = parseMarkdown('3. one\n\n   more text\n\n   ```js\n   x()\n   ```\n\n4. two');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ type: 'ordered_list', start: 3 });
    const items = (tokens[0] as { items: Array<{ text: string; children: unknown[] }> }).items;
    expect(items.map((i) => i.text)).toEqual(['one', 'two']);
    expect(items[0]?.children).toEqual([
      { type: 'paragraph', text: 'more text' },
      { type: 'code_block', lang: 'js', code: 'x()' },
    ]);
    const html = renderToStaticMarkup(createElement(SafeMarkdown, { content: '3. one\n   - sub\n4. two' }));
    expect(html).toContain('<ol class="aurvin-list" start="3"><li>one<ul class="aurvin-list"><li>sub</li></ul></li><li>two</li></ol>');
  });

  it('caps depth with plain paragraphs instead of unbounded recursion', () => {
    const deep = Array.from({ length: 12 }, (_, i) => `${'  '.repeat(i)}- L${i}`).join('\n');
    expect(() => renderToStaticMarkup(createElement(SafeMarkdown, { content: deep }))).not.toThrow();
    expect(renderToStaticMarkup(createElement(SafeMarkdown, { content: deep }))).toContain('L11');
  });
});

describe('streaming partial tables and lists', () => {
  it('never throws on any prefix of table and nested-list text', () => {
    const doc = '- a\n  - b\n\t1. c\n\n| h1 | h2 |\n|:--|--:|\n| 1 | 2 \\| 3 |\n- z';
    for (let n = 0; n <= doc.length; n++) {
      const partial = doc.slice(0, n);
      expect(() => parseMarkdown(partial)).not.toThrow();
      expect(() => renderToStaticMarkup(createElement(SafeMarkdown, { content: partial }))).not.toThrow();
    }
  });

  it('shows a half-received delimiter row as a header-only table', () => {
    expect(parseMarkdown('| a | b |\n|---|-')[0]).toMatchObject({
      type: 'table', header: ['a', 'b'], rows: [], align: [null, null],
    });
    expect(parseMarkdown('- a\n  - ')[0]).toMatchObject({ type: 'bullet_list' });
  });
});

describe('Release 1 rendering polish', () => {
  const html = (content: string) => renderToStaticMarkup(createElement(SafeMarkdown, { content }));

  it('renders horizontal rules and strikethrough', () => {
    expect(parseMarkdown('a\n\n---\n\n* * *\n\nb').map((t) => t.type)).toEqual(['paragraph', 'hr', 'hr', 'paragraph']);
    const out = html('before\n\n---\n\n~~gone~~ kept');
    expect(out).toContain('<hr class="aurvin-hr"/>');
    expect(out).toContain('<del>gone</del> kept');
    expect(html('- item\n- other')).not.toContain('<hr');
  });

  it('renders task lists as inert checkboxes', () => {
    const out = html('- [x] done\n- [ ] todo\n- plain');
    expect(out.match(/<input type="checkbox"[^>]*>/g)).toHaveLength(2);
    expect(out.match(/disabled/g)).toHaveLength(2);
    expect(out).toContain('checked');
    expect(out).not.toContain('[x]');
  });

  it('code block has a language label and copy button', () => {
    const out = html('```ts\nconst x = 1;\n```');
    expect(out).toContain('<span class="aurvin-code-lang">ts</span>');
    expect(out).toContain('aria-label="Copy code"');
    expect(html('```\nx\n```')).toContain('<span class="aurvin-code-lang">code</span>');
  });

  it('unterminated fence stays safe while streaming', () => {
    const out = html('```js\n<script>alert(1)</script>\nlet a = 1');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).not.toContain('<script');
    expect(out).toContain('aurvin-code-block');
  });

  it('raw HTML is still escaped', () => {
    const out = html('<img src=x onerror=alert(1)> and [x](javascript:alert(1)) ~~<b>y</b>~~');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<b>');
    expect(out).not.toContain('href="javascript');
    expect(out).toContain('&lt;img');
  });
});

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

/**
 * ============================================================================
 * FILE: web-search-presentation.test.ts
 * LOCATION: frontend/src/features/plugins/web-search/web-search-presentation.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify folding and rendering of web activities and HTTP(S)-only source citations.
 *
 * ROLE IN PROJECT:
 *    Ensures searching/reading/fallback/completed/failed/cancelled labels stay
 *    concise and honest, unsafe URLs never become links, and no sources are invented.
 *
 * KEY COMPONENTS:
 *    - foldWebActivities / foldWebSources / summarizeWebActivities
 *    - WebSearchActivityView rendered markup
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WebSourceReference } from '../../../api/web-search-protocol.ts';
import {
  foldWebActivities,
  foldWebSources,
  summarizeWebActivities,
} from './web-search-presentation.ts';
import { WebSearchActivityView } from './WebSearchActivityView.tsx';

const src = (id: string, url: string): WebSourceReference => ({
  sourceId: id,
  toolCallId: 'call_1',
  provider: 'exa',
  kind: 'browse',
  title: `Source ${id}`,
  url,
  retrievedAt: '2026-11-14T00:00:00.000Z',
});

describe('web-search-presentation', () => {
  it('folds bounded activities and summarizes searching, reading, fallback, failed, and cancelled honestly', () => {
    const acts = foldWebActivities(
      [],
      { toolCallId: 'c1', mode: 'browse', phase: 'searching', provider: 'tinyfish', code: null },
    );
    expect(summarizeWebActivities(acts).label).toBe('Searching the web…');

    const reading = foldWebActivities(acts, {
      toolCallId: 'c2',
      mode: 'fetch',
      phase: 'reading',
      provider: 'exa',
      code: null,
    });
    expect(summarizeWebActivities(reading).label).toBe('Reading page…');

    const fallback = foldWebActivities(reading, {
      toolCallId: 'c1',
      mode: 'browse',
      phase: 'fallback',
      provider: 'keenable',
      code: null,
    });
    expect(summarizeWebActivities(fallback).label).toBe('Trying backup provider…');

    const completed = summarizeWebActivities([
      { toolCallId: 'c1', mode: 'browse', phase: 'completed', provider: 'tavily', code: null },
    ]);
    expect(completed.label).toBe('');

    const failed = summarizeWebActivities([
      { toolCallId: 'c1', mode: 'fetch', phase: 'failed', provider: 'exa', code: 'WEB_URL_UNSAFE' },
    ]);
    expect(failed.tone).toBe('failed');
    expect(failed.label).toContain('blocked');

    const cancelled = summarizeWebActivities([
      { toolCallId: 'c1', mode: 'browse', phase: 'cancelled', provider: null, code: null },
    ]);
    expect(cancelled.tone).toBe('cancelled');
    expect(cancelled.label).toContain('cancelled');
  });

  it('instructs the user to reconnect when the saved credentials are rejected', () => {
    const summary = summarizeWebActivities([
      { toolCallId: 'web_call', mode: 'browse', phase: 'failed', provider: null, code: 'WEB_PROVIDER_AUTH' },
    ]);
    expect(summary.tone).toBe('failed');
    expect(summary.label).toBe(
      'The saved Web Search credentials are invalid or expired. Reconnect a provider in Plugins → Web Search.',
    );
  });

  it('renders only HTTP(S) links as clickable anchors and never fabricates sources', () => {
    const folded = foldWebSources(
      [src('s1', 'https://example.com/one')],
      [
        src('s1', 'https://example.com/one'),
        src('s2', 'http://docs.example.org/two'),
        src('bad1', 'javascript:alert(1)'),
        src('bad2', 'mailto:a@example.com'),
        src('bad3', '/relative'),
      ],
    );
    expect(folded.map((s) => s.sourceId)).toEqual(['s1', 's2']);

    const html = renderToStaticMarkup(
      createElement(WebSearchActivityView, {
        activities: [{ toolCallId: 'c1', mode: 'browse', phase: 'completed', provider: 'exa', code: null }],
        sources: [
          src('s1', 'https://example.com/one'),
          { ...src('tampered', 'javascript:alert(1)'), title: 'Unsafe payload' },
        ],
      }),
    );

    expect(html).toContain('href="https://example.com/one"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('Sources');
    expect(html).not.toContain('Verified');

    const emptyHtml = renderToStaticMarkup(
      createElement(WebSearchActivityView, { activities: [], sources: [] }),
    );
    expect(emptyHtml).toBe('');
  });
});

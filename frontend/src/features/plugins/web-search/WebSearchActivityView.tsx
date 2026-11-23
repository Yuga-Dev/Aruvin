/**
 * ============================================================================
 * FILE: WebSearchActivityView.tsx
 * LOCATION: frontend/src/features/plugins/web-search/WebSearchActivityView.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Render concise web search/fetch progress and safe clickable HTTP(S) sources.
 *
 * ROLE IN PROJECT:
 *    Shared by text chat assistant bubbles, VoiceTranscriptModal, and LiveVoicePanel.
 *
 * KEY COMPONENTS:
 *    - WebSearchActivityView: Activity status badge + HTTP(S)-filtered source chips.
 * ============================================================================
 */

import type { WebSearchActivity, WebSourceReference } from '../../../api/web-search-protocol.ts';
import { sanitizeWebSourceUrl } from '../../chat/markdown/sanitize-url.ts';
import { providerDisplayName, summarizeWebActivities } from './web-search-presentation.ts';

export type WebSearchActivityViewProps = {
  activities?: readonly WebSearchActivity[];
  sources?: readonly WebSourceReference[];
  variant?: 'chat' | 'voice';
};

function formatHostname(safeUrl: string): string {
  try {
    return new URL(safeUrl).hostname;
  } catch {
    return '';
  }
}

export function WebSearchActivityView({
  activities = [],
  sources = [],
  variant = 'chat',
}: WebSearchActivityViewProps) {
  const safeSources = sources
    .map((source) => ({ source, safeUrl: sanitizeWebSourceUrl(source.url) }))
    .filter((entry) => entry.safeUrl !== '');

  if (activities.length === 0 && safeSources.length === 0) {
    return null;
  }

  const summary = summarizeWebActivities(activities);

  return (
    <section
      className={`aurvin-web-presentation aurvin-web-presentation-${variant}`}
      aria-label="Web search activity and sources"
    >
      {summary.label ? (
        <p
          className={`aurvin-web-activity-pill aurvin-web-activity-${summary.tone}`}
          role="status"
          aria-live="polite"
        >
          {summary.label}
        </p>
      ) : null}

      {safeSources.length > 0 ? (
        <details className="aurvin-web-sources">
          <summary className="aurvin-web-sources-heading">Sources</summary>
          <ul className="aurvin-web-sources-list">
            {safeSources.map(({ source, safeUrl }) => {
              const host = formatHostname(safeUrl);
              return (
                <li key={source.sourceId} className="aurvin-web-source-item">
                  <a
                    className="aurvin-web-source-link"
                    href={safeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span className="aurvin-web-source-title">{source.title}</span>
                    <span className="aurvin-web-source-meta">
                      {host ? `${host} · ` : ''}
                      {providerDisplayName(source.provider)}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

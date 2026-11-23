/**
 * ============================================================================
 * FILE: index.ts
 * LOCATION: frontend/src/features/plugins/web-search/index.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Expose the Web Search plugin setup panel, turn presentation view, and folding helpers.
 *
 * ROLE IN PROJECT:
 *    Provides a clean public module boundary for AdminDashboard, chat, and live voice.
 *
 * KEY COMPONENTS:
 *    - WebSearchPanel: Plugins -> Web Search setup UI.
 *    - WebSearchActivityView / foldWebActivities / foldWebSources: Turn presentation.
 * ============================================================================
 */

export { WebSearchPanel, type WebSearchPanelProps } from './WebSearchPanel.tsx';
export { WebSearchActivityView, type WebSearchActivityViewProps } from './WebSearchActivityView.tsx';
export {
  foldWebActivities,
  foldWebSources,
  providerDisplayName,
  summarizeWebActivities,
  type WebActivitySummary,
} from './web-search-presentation.ts';

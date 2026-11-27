/**
 * ============================================================================
 * FILE: feature-flags.ts
 * LOCATION: frontend/src/app/feature-flags.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Compile-time switches for workspace areas that have no backend yet.
 *
 * ROLE IN PROJECT:
 *    Navigation only renders an area when its flag is on, so unfinished
 *    capabilities never appear as if they work. Turn a flag on in the
 *    release that ships the area's backend. These are not runtime or
 *    per-user settings and must never come from VITE_* variables.
 *
 * KEY COMPONENTS:
 *    - FEATURE_FLAGS: all off in Release 0
 * ============================================================================
 */

export const FEATURE_FLAGS = {
  home: false,
  projects: false, // Release 5
  agents: false, // Release 3
  memory: false, // Release 5
  workspace: false, // Release 2
  automations: false, // Release 8
  canvasMoreDiagrams: false, // Release 2: mindmap, ER and class diagrams in Canvas
  canvasCalendarGrid: false, // Release 2: Day/Week toggle on Calendar agenda
  canvasTables: false, // Release 2: ```table blocks as sortable/filterable Canvas tables
  conversationSearch: false, // Release 1: sidebar and palette search
  messageEdit: false, // Release 1: edit latest user message and regenerate latest answer
  feedback: false, // Release 1: thumbs up/down on assistant messages
  exportMarkdown: false, // Release 1: Export as Markdown in the chat header menu
  canvasExportPrint: false, // Release 2: PNG export and Print in the Canvas toolbar
  taskMode: false, // Release 3: Task toggle in the composer (docs/task-mode-and-flows); on after release approval
} as const;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;

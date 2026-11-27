# Release 2 pull-forward: bundle split, PNG export, print

Status: implemented and unit-tested in Node. Not verified in a real browser. Review is **skipped**.

## Bundle split

Measured with `npm run build` in `frontend/` (Vite 8). Sizes are minified / gzip.

| Build | Chunks | Initial load (index + react-vendor + client) |
| --- | --- | --- |
| Before (Release 2 base, before merging main) | `index` 1,396 kB / 377 kB (one chunk) + Vite 500 kB warning | 1,396 kB |
| After (merged with main, incl. table and calendar-grid renderers) | `index` 365 kB / 100 kB, `react-vendor` 219 kB / 68 kB, `client` 72 kB / 20 kB, `CanvasPanel` 74 kB / 22 kB, `AdminDashboard` 137 kB / 34 kB, `livekit-voice-client` 552 kB / 144 kB | about 656 kB / 188 kB |

What is lazy:

- **LiveKit transport** (`livekit-client`): `features/voice/state/lazy-livekit-client.ts`. The controller port is a proxy; the chunk is prefetched once live voice is enabled so the gesture-bound `prepare()` runs synchronously. If the chunk is not yet loaded when the user starts voice, `prepare()` awaits it first (may weaken the browser activation gesture; verify in Safari).
- **Canvas panel and its renderers** (mermaid, chart, svg, table, calendar, weather): `LazyCanvasPanel` in `ChatView.tsx`. The `canvas/index.ts` barrel no longer re-exports `CanvasPanel` or renderer components as values (that kept them in the main chunk); import them from their modules.
- **Admin dashboard** (settings, analytics, personalization, plugins panels): `LazyAdminDashboard` in `App.tsx`.
- `react-vendor` is split by `manualChunks` for caching and to keep app chunks small.

Failure and loading: `app/lazy.tsx` `lazyComponent` + `LazyBoundary`. Loading shows a labelled status; a failed chunk fetch shows an alert with a Retry button, and the failed import is not cached so Retry re-requests it.

Remaining Vite warning: `livekit-voice-client` (552 kB) is third-party SDK code that loads only for live voice, so `build.chunkSizeWarningLimit` is set to 600 kB with a comment. No chunk of app code is near the default limit; the largest initial app chunk is 365 kB. The `/api` proxy is unchanged.

## PNG export and print

Behind flag `canvasExportPrint` (default off; one additive line in `app/feature-flags.ts`). Code: `features/canvas/canvas-export.ts`, controls in `CanvasPanel.tsx`, print CSS in `canvas-print.css`.

PNG (diagram, chart and SVG artifacts in Preview mode; not tables, calendar, weather or Code view):

- SVG is cloned, computed styles (including `var()` colors) are inlined, namespaces, explicit size and viewBox are added, then SVG -> `Image` -> `<canvas>` -> `toBlob('image/png')`.
- Scale = `devicePixelRatio` clamped to 1..3, reduced to stay within 8192 px on the longest edge and 36 million pixels. An artifact over the limits at 1x fails with a "too large" message.
- Background: the current theme's painted background (default) or transparent via the "Transparent" toggle (`aria-pressed`).
- Errors shown in the toolbar (`role="alert"`): no measurable size, too large, tainted canvas (SecurityError), image failed to load (10 s timeout), encode failure, unsupported browser. Each suggests SVG download.
- Limits: `foreignObject` HTML inside an SVG, external images and web fonts may not render or may taint the canvas.

Print (all artifact kinds):

- A copy of the artifact (live SVG for diagrams and charts; the scroll body for table, calendar, weather and Code view) is put in `#aurvin-print-root`; `html[data-aurvin-printing]` hides everything else under `@media print`. The light theme is forced during printing and restored on `afterprint` (or after a 120 s safety timer).
- Limits: the printed copy is a DOM clone, so interactive state is not kept. If a browser never fires `afterprint`, the chat stays hidden up to 120 s.

## Tests (Node, no DOM)

- `canvas-export.test.ts`: DPR and limit math, SVG markup normalisation and background validation, error mapping, file stem, control availability.
- `app/lazy.test.ts`: single import, failed import not cached then retried, loading fallback.
- `voice/state/lazy-livekit-client.test.ts`: deferred construction, inert sync calls, retry, dispose without constructing.
- Existing tests adjusted: `ChatView.voice.test.ts` preloads the lazy Canvas panel; `live-voice-composition.test.ts` expects the lazy factory; canvas tests import `CanvasPanel` and renderers from their modules.

## Not verified

Real-browser rendering, actual PNG pixels, print preview output, chunk-fetch failure UI, and the voice gesture timing were not exercised. No staging or live provider checks were run.

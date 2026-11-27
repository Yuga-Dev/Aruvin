/**
 * ============================================================================
 * FILE: CanvasPanel.tsx
 * LOCATION: frontend/src/features/canvas/CanvasPanel.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Tabbed split-screen Canvas side panel with zoom, pan, code/preview, and export.
 *
 * ROLE IN PROJECT:
 *    Mounts beside the chat transcript inside ChatView when an artifact is
 *    opened, letting users inspect, zoom, pan, view source, copy, and download.
 *    Structured Calendar artifacts instead use an ordinary scrollable body
 *    without pan/zoom, source, copy, or download controls.
 *
 * KEY COMPONENTS:
 *    - CanvasPanel: Multi-tab header, toolbar controls, and interactive stage.
 *    - calendarBody: Read-only Calendar workspace body (no diagram stage).
 *    - CodeLinesView: Line-numbered raw source code inspector.
 * ============================================================================
 */

import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState,
  type Dispatch, type Ref, type SetStateAction } from 'react';
import type { CalendarConfirmPayload, CanvasControlArguments } from '../../api/voice-protocol.ts';
import { FEATURE_FLAGS } from '../../app/feature-flags.ts';
import {
  computeWheelZoomView,
  forcedChartKindFromSubType,
  parseChartSource,
  type CanvasPanelTransitionState,
} from './canvas-artifacts.ts';
import {
  DEFAULT_CANVAS_VIEW,
  MAX_CANVAS_ZOOM,
  MIN_CANVAS_ZOOM,
  applyCanvasControl,
  stepCanvasZoom,
  type CanvasView,
} from './canvas-controls.ts';
import {
  canvasExportAvailability,
  canvasFileStem,
  classifyPngError,
  exportSvgToPng,
  pngExportMessage,
  printCanvasElement,
} from './canvas-export.ts';
import './canvas-print.css';
import { matchesCanvasArtifact } from './weather-workspace.ts';
import { ArtifactKindIcon } from './CanvasArtifactCard.tsx';
import type { CanvasArtifact } from './canvas-types.ts';
import { TableRenderer } from './renderers/table-renderer.tsx';
import { CalendarEventRenderer } from './renderers/calendar-event-renderer.tsx';
import { CalendarViewBoundary, CalendarViewRenderer } from './renderers/calendar-view-renderer.tsx';
import { ChartRenderer } from './renderers/chart-renderer.tsx';
import { MermaidRenderer } from './renderers/mermaid-renderer.tsx';
import { SvgRenderer } from './renderers/svg-renderer.tsx';
import { WeatherViewBoundary, WeatherViewRenderer } from './renderers/weather-view-renderer.tsx';

export type CanvasPanelHandle = {
  apply: (command: CanvasControlArguments, expectedCanvasId: string) => 'applied' | 'unavailable' | 'unsupported';
};

export function toArtifactPath(artifact: CanvasArtifact): string {
  const slug = artifact.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'artifact';
  const ext =
    artifact.kind === 'mermaid'
      ? 'mmd'
      : artifact.kind === 'svg'
        ? 'svg'
        : artifact.kind === 'calendar'
          ? 'event.json'
          : artifact.kind === 'weather'
            ? 'weather.json'
            : artifact.kind === 'table'
              ? 'table.json'
              : 'chart.json';
  return `canvas/${slug}.${ext}`;
}

function CodeLinesView({ code, bodyRef }: { code: string; bodyRef?: Ref<HTMLDivElement> }) {
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  return (
    <div ref={bodyRef} className="aurvin-canvas-code-view" role="region" aria-label="Artifact source code">
      <ol className="aurvin-canvas-code-lines">
        {lines.map((line, idx) => (
          <li key={idx} className="aurvin-canvas-code-line">
            <span className="aurvin-canvas-line-num" aria-hidden="true">
              {idx + 1}
            </span>
            <span className="aurvin-canvas-line-text">{line || ' '}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function CanvasPanel({
  artifacts,
  activeArtifactId,
  onSelectArtifact,
  onCloseTab,
  onClosePanel,
  transitionState = 'open',
  panelRef,
  controlRef,
  onPresentationModeChange,
  onCalendarAnswer,
  calendarControlsDisabled = false,
  onChangeCity,
  changeCityDisabled = false,
  liveVoiceActive = false,
  onOpenPersonalization,
  maximized: maximizedProp,
  onMaximizedChange,
}: {
  artifacts: CanvasArtifact[];
  activeArtifactId: string | null;
  onSelectArtifact: (artifactId: string) => void;
  onCloseTab: (artifactId: string) => void;
  onClosePanel: () => void;
  transitionState?: CanvasPanelTransitionState;
  panelRef?: Ref<HTMLElement>;
  controlRef?: Ref<CanvasPanelHandle>;
  onPresentationModeChange?: (mode: 'diagram' | 'scroll') => void;
  onCalendarAnswer?: (proposalId: string, revision: number, answer: CalendarConfirmPayload['answer']) => void;
  calendarControlsDisabled?: boolean;
  onChangeCity?: (city: string) => void;
  changeCityDisabled?: boolean;
  liveVoiceActive?: boolean;
  onOpenPersonalization?: () => void;
  maximized?: boolean;
  onMaximizedChange?: Dispatch<SetStateAction<boolean>>;
}) {
  const activeArtifact =
    artifacts.find((a) => matchesCanvasArtifact(a, activeArtifactId)) ??
    artifacts[artifacts.length - 1] ??
    null;
  const calendarMode = activeArtifact?.kind === 'calendar';
  const weatherMode = activeArtifact?.kind === 'weather';
  const tableMode = activeArtifact?.kind === 'table';
  const structuredMode = calendarMode || weatherMode || tableMode;

  const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');
  const [view, setView] = useState<CanvasView>(DEFAULT_CANVAS_VIEW);
  const [isDragging, setIsDragging] = useState(false);
  const [localMaximized, setLocalMaximized] = useState(false);
  const maximized = maximizedProp ?? localMaximized;
  const setMaximized = onMaximizedChange ?? setLocalMaximized;
  const [copied, setCopied] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [transparentPng, setTransparentPng] = useState(false);

  const dragOriginRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(
    null,
  );
  const stageRef = useRef<HTMLDivElement | null>(null);
  const renderedStageRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const presentationMode: 'diagram' | 'scroll' =
    structuredMode || viewMode === 'code' ? 'scroll' : 'diagram';

  useLayoutEffect(() => {
    if (!activeArtifact) return;
    onPresentationModeChange?.(presentationMode);
  }, [activeArtifact, onPresentationModeChange, presentationMode]);

  useImperativeHandle(
    controlRef,
    () => ({
      apply: (command, expectedCanvasId) =>
        activeArtifact?.artifactId !== expectedCanvasId
          ? 'unavailable'
          : applyCanvasControl(command, {
              mode: presentationMode,
              open: transitionState === 'open' && activeArtifact !== null,
              getView: () => view,
              setView,
              viewport: stageRef.current,
              stage: renderedStageRef.current,
              body: bodyRef.current,
              close: onClosePanel,
              setMaximized,
            }),
    }),
    [presentationMode, transitionState, activeArtifact, view, onClosePanel],
  );

  useEffect(() => {
    const el = stageRef.current;
    if (!el || viewMode !== 'preview' || structuredMode) return;
    const handleNativeWheel = (e: WheelEvent) => {
      if (e.deltaY !== 0) {
        e.preventDefault();
      }
    };
    el.addEventListener('wheel', handleNativeWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleNativeWheel);
  }, [viewMode, activeArtifact?.artifactId, structuredMode]);

  if (!activeArtifact) {
    return null;
  }

  const { zoom } = view;

  const handleZoomOut = () => {
    setView((prev) => stepCanvasZoom(prev, -1));
  };

  const handleZoomIn = () => {
    setView((prev) => stepCanvasZoom(prev, 1));
  };

  const handleResetView = () => {
    setView({ ...DEFAULT_CANVAS_VIEW });
    if (bodyRef.current) {
      bodyRef.current.scrollTop = 0;
      bodyRef.current.scrollLeft = 0;
    }
  };

  const handleSelectTab = (artifactId: string) => {
    handleResetView();
    setCopied(false);
    onSelectArtifact(artifactId);
  };

  const handleCopy = async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(activeArtifact.rawSource);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }
    } catch {
      // Clipboard API unavailable in non-secure or headless context
    }
  };

  const handleDownload = () => {
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
    const slug =
      activeArtifact.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'aurvin-canvas';

    const svgEl =
      viewMode === 'preview' ? stageRef.current?.querySelector('svg') ?? null : null;

    let content = activeArtifact.rawSource;
    let mime = 'text/plain;charset=utf-8';
    let ext = activeArtifact.kind === 'mermaid' ? 'mmd' : activeArtifact.kind === 'svg' ? 'svg' : 'json';

    if (svgEl && typeof XMLSerializer !== 'undefined') {
      const serialized = new XMLSerializer().serializeToString(svgEl);
      content = serialized.includes('xmlns=')
        ? serialized
        : serialized.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
      mime = 'image/svg+xml;charset=utf-8';
      ext = 'svg';
    }

    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${slug}.${ext}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const exportControls = canvasExportAvailability({
    flagOn: FEATURE_FLAGS.canvasExportPrint,
    structuredMode,
    viewMode,
  });

  const handleExportPng = async () => {
    const svgEl = stageRef.current?.querySelector('svg') ?? null;
    if (!svgEl || exportBusy) return;
    setExportBusy(true);
    setExportNotice(null);
    try {
      const blob = await exportSvgToPng(svgEl, { background: transparentPng ? 'transparent' : 'theme' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${canvasFileStem(activeArtifact.title)}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportNotice(pngExportMessage(classifyPngError(error).code));
    } finally {
      setExportBusy(false);
    }
  };

  const handlePrint = () => {
    // Diagrams print the live SVG; structured views and code print their scroll body.
    const source =
      !structuredMode && viewMode === 'preview'
        ? stageRef.current?.querySelector('svg') ?? null
        : bodyRef.current;
    if (!source) {
      setExportNotice('There is nothing to print yet.');
      return;
    }
    setExportNotice(null);
    printCanvasElement(source, activeArtifact.title);
  };

  const artifactPath = toArtifactPath(activeArtifact);
  const isExiting = transitionState === 'exiting';

  const calendarBody=<div ref={bodyRef} className="aurvin-canvas-calendar-body" role="region" aria-label="Calendar workspace">
    {activeArtifact.calendarView || activeArtifact.calendarWorkspace ?
      <CalendarViewBoundary key={activeArtifact.artifactId} value={activeArtifact.calendarWorkspace?.view ?? activeArtifact.calendarView ?? null}>
        <CalendarViewRenderer view={activeArtifact.calendarWorkspace?.view ?? activeArtifact.calendarView ?? null}
          workspace={activeArtifact.calendarWorkspace} disabled={calendarControlsDisabled}
          onAnswer={activeArtifact.calendarWorkspace?.view?.kind === 'proposal' && onCalendarAnswer ? answer=>{
            const view=activeArtifact.calendarWorkspace!.view!;
            if (view.kind === 'proposal') onCalendarAnswer(view.proposalId,view.revision,answer);
          } : undefined}/>
      </CalendarViewBoundary> : <CalendarEventRenderer source={activeArtifact.rawSource} title={activeArtifact.title}/>}
  </div>;

  const weatherBody = (
    <div
      ref={bodyRef}
      className="aurvin-canvas-weather-body"
      role="region"
      aria-label="Weather forecast"
    >
      <WeatherViewBoundary
        key={activeArtifact.artifactId}
        value={activeArtifact.weatherWorkspace?.view ?? activeArtifact.weatherView ?? null}
      >
        <WeatherViewRenderer
          view={activeArtifact.weatherWorkspace?.view ?? activeArtifact.weatherView ?? null}
          onChangeCity={onChangeCity}
          changeCityDisabled={changeCityDisabled}
          liveVoiceActive={liveVoiceActive}
          onOpenPersonalization={onOpenPersonalization}
        />
      </WeatherViewBoundary>
    </div>
  );

  return (
    <aside
      ref={panelRef}
      id="aurvin-canvas-panel"
      className={`aurvin-canvas-panel${maximized ? ' aurvin-canvas-panel-maximized' : ''}`}
      aria-label="Aurvin Canvas"
      data-active-artifact-id={activeArtifact.artifactId}
      data-canvas-state={transitionState}
      aria-hidden={isExiting ? 'true' : undefined}
      inert={isExiting}
    >
      {/* Top Tab Bar matching the Canvas screenshot */}
      <div className="aurvin-canvas-tabs-bar">
        <div className="aurvin-canvas-tabs-scroll" role="tablist" aria-label="Canvas artifacts">
          {artifacts.map((item) => {
            const isSelected = item.artifactId === activeArtifact.artifactId;
            return (
              <div
                key={item.artifactId}
                className="aurvin-canvas-tab-item"
                data-selected={isSelected ? 'true' : 'false'}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  className="aurvin-canvas-tab-btn"
                  onClick={() => handleSelectTab(item.artifactId)}
                  title={item.title}
                >
                  <ArtifactKindIcon kind={item.kind} subType={item.subType} size={14} />
                  <span className="aurvin-canvas-tab-title">{item.title}</span>
                </button>
                <button
                  type="button"
                  className="aurvin-canvas-tab-close"
                  aria-label={`Close ${item.title} tab`}
                  onClick={() => onCloseTab(item.artifactId)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>

        <div className="aurvin-canvas-window-actions">
          <button
            type="button"
            className="aurvin-canvas-icon-btn"
            aria-label={maximized ? 'Restore split view' : 'Expand canvas'}
            title={maximized ? 'Restore split view' : 'Expand canvas'}
            onClick={() => setMaximized((m) => !m)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M12 4v16" />
            </svg>
          </button>
          <button
            type="button"
            className="aurvin-canvas-icon-btn"
            aria-label="Close canvas"
            title="Close canvas"
            onClick={onClosePanel}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Subheader / Path & Interactive Controls Toolbar */}
      <div className="aurvin-canvas-toolbar">
        <div className="aurvin-canvas-breadcrumb">
          <span className="aurvin-canvas-path">{artifactPath}</span>
          <span className="aurvin-canvas-badge">{activeArtifact.subType}</span>
        </div>

        <div className="aurvin-canvas-controls">
          {!structuredMode ? (
            <>
          <div className="aurvin-canvas-mode-group" role="group" aria-label="Canvas view mode">
            <button
              type="button"
              className="aurvin-canvas-mode-btn"
              data-active={viewMode === 'preview' ? 'true' : 'false'}
              onClick={() => setViewMode('preview')}
            >
              Preview
            </button>
            <button
              type="button"
              className="aurvin-canvas-mode-btn"
              data-active={viewMode === 'code' ? 'true' : 'false'}
              onClick={() => setViewMode('code')}
            >
              Code
            </button>
          </div>

          {viewMode === 'preview' ? (
            <div className="aurvin-canvas-zoom-group" role="group" aria-label="Zoom controls">
              <button
                type="button"
                className="aurvin-canvas-icon-btn"
                aria-label="Zoom out"
                title="Zoom out"
                onClick={handleZoomOut}
                disabled={zoom <= MIN_CANVAS_ZOOM}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  <line x1="8" y1="11" x2="14" y2="11" />
                </svg>
              </button>
              <button
                type="button"
                className="aurvin-canvas-zoom-reset"
                aria-label="Reset zoom"
                title="Reset zoom and center"
                onClick={handleResetView}
              >
                {zoom}%
              </button>
              <button
                type="button"
                className="aurvin-canvas-icon-btn"
                aria-label="Zoom in"
                title="Zoom in"
                onClick={handleZoomIn}
                disabled={zoom >= MAX_CANVAS_ZOOM}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  <line x1="11" y1="8" x2="11" y2="14" />
                  <line x1="8" y1="11" x2="14" y2="11" />
                </svg>
              </button>
            </div>
          ) : null}

          <button
            type="button"
            className="aurvin-canvas-icon-btn"
            aria-label="Copy artifact source"
            title={copied ? 'Copied!' : 'Copy source'}
            onClick={() => void handleCopy()}
          >
            {copied ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>

          <button
            type="button"
            className="aurvin-canvas-icon-btn"
            aria-label="Download artifact"
            title="Download artifact"
            onClick={handleDownload}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
          {exportControls.png ? (
            <>
              <button
                type="button"
                className="aurvin-canvas-icon-btn"
                aria-label="Export as PNG"
                title="Export as PNG"
                onClick={() => void handleExportPng()}
                disabled={exportBusy}
              >
                PNG
              </button>
              <button
                type="button"
                className="aurvin-canvas-icon-btn"
                aria-label="Transparent PNG background"
                aria-pressed={transparentPng}
                title="Transparent PNG background"
                onClick={() => setTransparentPng((value) => !value)}
              >
                Transparent
              </button>
            </>
          ) : null}
            </>
          ) : null}
          {exportControls.print ? (
            <button
              type="button"
              className="aurvin-canvas-icon-btn"
              aria-label="Print artifact"
              title="Print artifact"
              onClick={handlePrint}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <polyline points="6 9 6 2 18 2 18 9" />
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                <rect x="6" y="14" width="12" height="8" />
              </svg>
            </button>
          ) : null}
          {exportNotice ? (
            <span className="aurvin-canvas-export-notice" role="alert">{exportNotice}</span>
          ) : null}
        </div>
      </div>

      {/* Main Canvas Body */}
      <div className="aurvin-canvas-body">
        {tableMode && viewMode === 'preview' ? (
          <div ref={bodyRef} className="aurvin-canvas-calendar-body aurvin-canvas-table-body">
            <TableRenderer source={activeArtifact.rawSource} title={activeArtifact.title} />
          </div>
        ) : calendarMode ? calendarBody : weatherMode ? weatherBody : viewMode === 'code' ? (
          <CodeLinesView code={activeArtifact.rawSource} bodyRef={bodyRef} />
        ) : (
          <div
            ref={stageRef}
            className={`aurvin-canvas-viewport${isDragging ? ' aurvin-canvas-viewport-dragging' : ''}`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              setIsDragging(true);
              dragOriginRef.current = {
                startX: e.clientX,
                startY: e.clientY,
                panX: view.panX,
                panY: view.panY,
              };
            }}
            onPointerMove={(e) => {
              if (!isDragging || !dragOriginRef.current) return;
              const dx = e.clientX - dragOriginRef.current.startX;
              const dy = e.clientY - dragOriginRef.current.startY;
              const origin = dragOriginRef.current;
              setView((prev) => ({
                ...prev,
                panX: origin.panX + dx,
                panY: origin.panY + dy,
              }));
            }}
            onPointerUp={() => {
              setIsDragging(false);
              dragOriginRef.current = null;
            }}
            onPointerCancel={() => {
              setIsDragging(false);
              dragOriginRef.current = null;
            }}
            onWheel={(e) => {
              if (e.deltaY === 0) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const offsetX = rect.width > 0 ? e.clientX - (rect.left + rect.width / 2) : 0;
              const offsetY = rect.height > 0 ? e.clientY - (rect.top + rect.height / 2) : 0;
              setView((prev) => computeWheelZoomView(prev, e.deltaY, offsetX, offsetY));
            }}
          >
            <div
              ref={renderedStageRef}
              className="aurvin-canvas-stage"
              style={{
                transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom / 100})`,
              }}
            >
              {activeArtifact.kind === 'mermaid' ? (
                <MermaidRenderer
                  source={activeArtifact.rawSource}
                  title={activeArtifact.title}
                />
              ) : activeArtifact.kind === 'chart' ? (
                <ChartRenderer
                  source={activeArtifact.rawSource}
                  title={activeArtifact.title}
                  model={parseChartSource(
                    activeArtifact.rawSource,
                    activeArtifact.title,
                    forcedChartKindFromSubType(activeArtifact.subType, activeArtifact.rawSource),
                  )}
                />
              ) : activeArtifact.kind === 'calendar' ? (
                <CalendarEventRenderer
                  source={activeArtifact.rawSource}
                  title={activeArtifact.title}
                />
              ) : (
                <SvgRenderer
                  source={activeArtifact.rawSource}
                  title={activeArtifact.title}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

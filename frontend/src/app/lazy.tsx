/**
 * ============================================================================
 * FILE: lazy.tsx
 * LOCATION: frontend/src/app/lazy.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Retry-able lazy component loader plus a Suspense/error boundary.
 *
 * ROLE IN PROJECT:
 *    Used at the import sites of heavy, non-initial features (Canvas panel,
 *    admin dashboard) so their code ships in separate chunks. A failed chunk
 *    fetch shows an error with a Retry button instead of a blank screen, and
 *    retrying re-requests the chunk. After preload() the component renders
 *    synchronously (used by tests and prefetch).
 *
 * KEY COMPONENTS:
 *    - lazyComponent: Wraps a dynamic import; exposes preload().
 *    - LazyBoundary: Suspense fallback + error state with retry.
 * ============================================================================
 */

import { Component, Suspense, use, type ComponentType, type ReactNode } from 'react'

export type LazyComponent<P> = ComponentType<P> & { preload: () => Promise<void> }

export function lazyComponent<P extends object>(
  importer: () => Promise<{ default: ComponentType<P> }>,
): LazyComponent<P> {
  let loaded: ComponentType<P> | null = null
  let pending: Promise<void> | null = null
  const preload = (): Promise<void> => {
    if (loaded) return Promise.resolve()
    pending ??= importer().then(
      (mod) => { loaded = mod.default },
      (error: unknown) => { pending = null; throw error }, // next attempt re-requests the chunk
    )
    return pending
  }
  function Lazy(props: P) {
    if (loaded) { const Loaded = loaded; return <Loaded {...props} /> }
    use(preload())
    const Loaded = loaded as ComponentType<P> | null
    return Loaded ? <Loaded {...props} /> : null
  }
  return Object.assign(Lazy, { preload })
}

type BoundaryProps = { children: ReactNode; label: string; fallback?: ReactNode }

export class LazyBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) {
      return (
        <div className="aurvin-lazy-error" role="alert">
          <p>{this.props.label} could not be loaded. Check your connection and try again.</p>
          <button type="button" className="aurvin-quiet-btn" onClick={() => this.setState({ failed: false })}>
            Retry
          </button>
        </div>
      )
    }
    return (
      <Suspense
        fallback={this.props.fallback ?? (
          <div className="aurvin-lazy-loading" role="status">Loading {this.props.label}…</div>
        )}
      >
        {this.props.children}
      </Suspense>
    )
  }
}

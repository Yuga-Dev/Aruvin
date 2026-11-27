/**
 * ============================================================================
 * FILE: lazy.test.ts
 * LOCATION: frontend/src/app/lazy.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Tests for lazyComponent loading, caching, failure and retry state.
 *
 * ROLE IN PROJECT:
 *    Node-only: checks that a failed chunk fetch rejects, is not cached, and
 *    that a retry renders the component synchronously. The retry button UI and
 *    real chunk fetches need a browser.
 *
 * KEY COMPONENTS:
 *    - lazyComponent preload/failure/retry; LazyBoundary fallback markup.
 * ============================================================================
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LazyBoundary, lazyComponent } from './lazy.tsx'

const Hello = ({ name }: { name: string }) => createElement('b', null, `hi ${name}`)

describe('lazyComponent', () => {
  it('imports once and renders synchronously after preload', async () => {
    let calls = 0
    const Lazy = lazyComponent<{ name: string }>(async () => { calls++; return { default: Hello } })
    await Lazy.preload()
    await Lazy.preload()
    expect(calls).toBe(1)
    expect(renderToStaticMarkup(createElement(Lazy, { name: 'a' }))).toBe('<b>hi a</b>')
  })

  it('does not cache a failed import and succeeds on retry', async () => {
    let calls = 0
    const Lazy = lazyComponent<{ name: string }>(async () => {
      calls++
      if (calls === 1) throw new Error('chunk fetch failed')
      return { default: Hello }
    })
    await expect(Lazy.preload()).rejects.toThrow('chunk fetch failed')
    await Lazy.preload()
    expect(calls).toBe(2)
    expect(renderToStaticMarkup(createElement(Lazy, { name: 'b' }))).toBe('<b>hi b</b>')
  })

  it('shows a labelled loading fallback while the chunk is pending', () => {
    const Lazy = lazyComponent<{ name: string }>(() => new Promise(() => {}))
    const html = renderToStaticMarkup(
      createElement(LazyBoundary, { label: 'Canvas', children: createElement(Lazy, { name: 'c' }) }),
    )
    expect(html).toContain('Loading Canvas')
    expect(html).toContain('role="status"')
  })
})

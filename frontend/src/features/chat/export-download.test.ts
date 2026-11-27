/**
 * ============================================================================
 * FILE: export-download.test.ts
 * LOCATION: frontend/src/features/chat/export-download.test.ts
 * ============================================================================
 * PURPOSE: Verify the safe export filename and Blob download flow.
 * ROLE IN PROJECT: Node-environment checks for Release 1 Markdown export.
 * KEY COMPONENTS: exportFileName, exportChat success and failure.
 * ============================================================================
 */
import { describe, expect, it, vi } from 'vitest';
import { exportChat, exportFileName } from './export-download.ts';

const now = new Date('2026-11-27T10:00:00Z');

describe('export download', () => {
  it('builds a safe filename and triggers a Blob download', async () => {
    expect(exportFileName('../My "Trip" /plan\r\n', now)).toBe('my-trip-plan-2026-11-27.md');
    expect(exportFileName('日本語', now)).toBe('chat-2026-11-27.md');
    expect(exportFileName('x'.repeat(200), now)).toMatch(/^x{60}-2026-11-27\.md$/);
    const blob = new Blob(['# T']);
    const download = vi.fn();
    const client = { exportSession: vi.fn(async () => blob) };
    await expect(exportChat({ client, sessionId: 's1', title: 'Trip', download, now })).resolves.toBe(true);
    expect(client.exportSession).toHaveBeenCalledWith('s1');
    expect(download).toHaveBeenCalledWith(blob, 'trip-2026-11-27.md');
  });

  it('shows an error without downloading on failure', async () => {
    const download = vi.fn();
    const client = { exportSession: vi.fn(async () => { throw new Error('500'); }) };
    await expect(exportChat({ client, sessionId: 's1', title: 'Trip', download, now })).resolves.toBe(false);
    expect(download).not.toHaveBeenCalled();
  });
});

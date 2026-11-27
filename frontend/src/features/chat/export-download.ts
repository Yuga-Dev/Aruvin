/**
 * ============================================================================
 * FILE: export-download.ts
 * LOCATION: frontend/src/features/chat/export-download.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Fetch the server-built Markdown export and save it through a Blob download.
 *
 * ROLE IN PROJECT:
 *    Release 1 export. No dependency; the server is the only source of the content.
 *
 * KEY COMPONENTS:
 *    - exportFileName: ASCII slug + date, at most 60 slug chars.
 *    - exportChat: fetch, then download; returns false (no download) on failure.
 * ============================================================================
 */

export function exportFileName(title: string, now: Date = new Date()): string {
  const slug = title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60).replace(/-+$/, '');
  return `${slug || 'chat'}-${now.toISOString().slice(0, 10)}.md`;
}

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function exportChat(args: {
  client: { exportSession(sessionId: string): Promise<Blob> };
  sessionId: string;
  title: string;
  download?: (blob: Blob, filename: string) => void;
  now?: Date;
}): Promise<boolean> {
  try {
    const blob = await args.client.exportSession(args.sessionId);
    (args.download ?? triggerDownload)(blob, exportFileName(args.title, args.now));
    return true;
  } catch {
    return false;
  }
}

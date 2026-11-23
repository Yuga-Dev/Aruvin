/**
 * ============================================================================
 * FILE: web-search-boundary.ts
 * LOCATION: backend/src/http/web-search-boundary.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Bound JSON parsing for the fixed web-search plugin mutation routes only.
 *
 * ROLE IN PROJECT:
 *    Installs a 16,384-byte strict parser after private authentication and
 *    before the generic chat parser so oversized plugin bodies never buffer or
 *    reach a controller, while unrelated routes keep their existing parser.
 *
 * KEY COMPONENTS:
 *    - configureWebSearchHttp: Exact mutation path matcher and parser.
 *    - Parser errors: P1 web-search HTTP error bodies without parser text.
 * ============================================================================
 */

import { json } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { WEB_SEARCH_POLICY } from '../contracts/web-search-policy.js';
import { WEB_SEARCH_HTTP_ERRORS, WEB_SEARCH_ROUTES,
  webSearchHttpErrorSchema } from '../contracts/web-search-wire.js';

const PROVIDER = '[a-z]+';
const PLUGIN = '/api/plugins/web-search';
const MUTATIONS: readonly RegExp[] = [
  new RegExp(`^${PLUGIN}/settings$`),
  new RegExp(`^${PLUGIN}/providers/${PROVIDER}/connect$`),
  new RegExp(`^${PLUGIN}/providers/${PROVIDER}/disconnect$`),
  new RegExp(`^${PLUGIN}/providers/${PROVIDER}/oauth/start$`),
  new RegExp(`^${PLUGIN}/providers/${PROVIDER}/oauth/complete$`),
];

function mutationPath(path: string): boolean {
  const normalized = path.replace(/\/+$/, '').toLowerCase();
  return MUTATIONS.some(pattern => pattern.test(normalized));
}

function errorBody(code: keyof typeof WEB_SEARCH_HTTP_ERRORS) {
  return webSearchHttpErrorSchema.parse({
    protocolVersion: 1,
    error: { code, retryable: WEB_SEARCH_HTTP_ERRORS[code].retryable, currentRevision: null },
  });
}

export function configureWebSearchHttp(app: Pick<NestExpressApplication, 'use'>): void {
  const parser = json({ limit: WEB_SEARCH_POLICY.maxHttpBodyBytes, strict: true });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!mutationPath(req.path)) { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    parser(req, res, (error?: unknown) => {
      if (!error) { next(); return; }
      const fault = typeof error === 'object' && error !== null
        ? error as { type?: unknown; status?: unknown } : null;
      if (fault?.type === 'entity.too.large') {
        res.status(WEB_SEARCH_HTTP_ERRORS.WEB_INPUT_TOO_LARGE.status)
          .json(errorBody('WEB_INPUT_TOO_LARGE'));
        return;
      }
      if (fault?.type === 'entity.parse.failed' || fault?.status === 400) {
        res.status(WEB_SEARCH_HTTP_ERRORS.WEB_INVALID_REQUEST.status)
          .json(errorBody('WEB_INVALID_REQUEST'));
        return;
      }
      res.status(WEB_SEARCH_HTTP_ERRORS.WEB_INVALID_REQUEST.status)
        .json(errorBody('WEB_INVALID_REQUEST'));
    });
  });
}

/** The five exact static callback paths, GET-only, for the private boundary. */
export const WEB_SEARCH_CALLBACK_PATHS: ReadonlySet<string> = new Set(
  (['tinyfish', 'keenable', 'exa', 'tavily', 'firecrawl'] as const)
    .map(provider => `/api${WEB_SEARCH_ROUTES.oauthCallback(provider)}`),
);

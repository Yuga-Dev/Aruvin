/**
 * ============================================================================
 * FILE: configure-personalization-http.ts
 * LOCATION: backend/src/personalization/configure-personalization-http.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Enforce 16-KiB strict JSON ingress bounds for /api/personalization routes.
 *
 * ROLE IN PROJECT:
 *    Installed in main.ts before global chat body parsers so personalization
 *    mutations enforce strict UTF-8 JSON object validation and byte caps.
 *
 * KEY COMPONENTS:
 *    - configurePersonalizationHttp: Middleware guarding /api/personalization.
 * ============================================================================
 */

import { json } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { MAX_PERSONALIZATION_BODY_BYTES } from '../contracts/personalization.js';
import { USER_MEMORY_ROUTES } from '../contracts/user-memory.js';
import { PersonalizationFault, UserMemoryFault } from './errors.js';

const MEMORY_METHOD = new Map<string, string>([
  [`/api${USER_MEMORY_ROUTES.memory}`, 'GET'],
  [`/api${USER_MEMORY_ROUTES.enabled}`, 'PATCH'],
  [`/api${USER_MEMORY_ROUTES.edit}`, 'POST'],
  [`/api${USER_MEMORY_ROUTES.clear}`, 'POST'],
  [`/api${USER_MEMORY_ROUTES.history}`, 'GET'],
]);
const SECTION_PATH = new RegExp(`^/api${USER_MEMORY_ROUTES.memory}/sections/[^/]+$`);
const HISTORY_PATH = `/api${USER_MEMORY_ROUTES.history}`;

function replyInvalid(res: Response, memory: boolean, statusOverride?: number): void {
  if (res.headersSent || res.writableEnded) return;
  const fault = memory ? new UserMemoryFault('INVALID_REQUEST') : new PersonalizationFault('INVALID_REQUEST');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(statusOverride ?? fault.status).json(fault.body());
}

export function configurePersonalizationHttp(
  app: Pick<NestExpressApplication, 'use'>,
): void {
  const parser = json({
    limit: MAX_PERSONALIZATION_BODY_BYTES,
    inflate: false,
    strict: true,
    type: 'application/json',
    verify: (_req, _res, bytes) => {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    },
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    const path = req.path.replace(/\/+$/, '').toLowerCase();
    const memoryMethod = SECTION_PATH.test(path) ? 'PATCH' : MEMORY_METHOD.get(path);
    const memory = memoryMethod !== undefined;
    if (!memory && path !== '/api/personalization' &&
      path !== '/api/personalization/reset' && path !== '/api/personalization/reverse-geocode') {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const isGet = (req.method === 'GET' && path === '/api/personalization') ||
      (memoryMethod === 'GET' && (req.method === 'GET' || req.method === 'HEAD'));
    const isPut = req.method === 'PUT' && path === '/api/personalization';
    const isReset = req.method === 'POST' && path === '/api/personalization/reset';
    const isReverseGeocode = req.method === 'POST' && path === '/api/personalization/reverse-geocode';
    const isMemoryWrite = memory && memoryMethod !== 'GET' && req.method === memoryMethod;
    if (!isGet && !isPut && !isReset && !isReverseGeocode && !isMemoryWrite) {
      next();
      return;
    }
    // History is the only memory route with a query string; its schema is strict.
    if ((req.url ?? '').includes('?') && path !== HISTORY_PATH) {
      replyInvalid(res, memory);
      return;
    }
    if (isGet) {
      if (memory && (req.headers['transfer-encoding'] !== undefined ||
        (req.headers['content-length'] !== undefined && Number(req.headers['content-length']) !== 0))) {
        replyInvalid(res, memory);
        return;
      }
      next();
      return;
    }

    const contentType = req.headers['content-type'];
    const encoding = req.headers['content-encoding'];
    const length = req.headers['content-length'];
    const validType =
      typeof contentType === 'string' &&
      /^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(contentType);
    const validLength =
      length === undefined ||
      (typeof length === 'string' &&
        /^\d+$/.test(length) &&
        Number.isSafeInteger(Number(length)) &&
        Number(length) > 0);

    if (
      !validType ||
      (encoding !== undefined && encoding !== 'identity') ||
      !validLength
    ) {
      replyInvalid(res, memory);
      return;
    }

    if (
      length !== undefined &&
      Number(length) > MAX_PERSONALIZATION_BODY_BYTES
    ) {
      replyInvalid(res, memory, 413);
      return;
    }

    parser(req, res, (error?: unknown) => {
      if (req.aborted || res.writableEnded) return;
      if (error) {
        const type =
          error !== null && typeof error === 'object' && 'type' in error
            ? String(error.type)
            : '';
        replyInvalid(res, memory, type === 'entity.too.large' ? 413 : 400);
        return;
      }
      const body: unknown = req.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        replyInvalid(res, memory);
        return;
      }
      next();
    });
  });
}

/**
 * ============================================================================
 * FILE: controller.ts
 * LOCATION: backend/src/plugins/web-search/controller.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Expose strict per-user web-search plugin HTTP routes and safe errors.
 *
 * ROLE IN PROJECT:
 *    Resolves identity only from the server principal, validates P1 request
 *    schemas, and maps closed faults without leaking provider or secret data.
 *
 * KEY COMPONENTS:
 *    - WebSearchController: Status/settings/connect/disconnect/OAuth routes.
 *    - WebSearchFilter: Closed P1 error mapping and auth-fault preservation.
 *    - abortOf: Request cancellation with listener cleanup.
 * ============================================================================
 */

import {
  Body, Catch, Controller, Get, HttpCode, Inject, Patch, Post, Req, Res,
  UseFilters, type ArgumentsHost, type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import type { AuthPrincipal } from '../../contracts/auth.js';
import { AuthFault } from '../../auth/errors.js';
import { AppError } from '../../platform/errors/app-error.js';
import {
  WEB_SEARCH_HTTP_ERRORS,
  webSearchConnectRequestSchema, webSearchDisconnectRequestSchema,
  webSearchHttpErrorSchema, webSearchOAuthCompleteRequestSchema,
  webSearchOAuthCompleteResponseSchema, webSearchOAuthStartRequestSchema,
  webSearchOAuthStartResponseSchema, webSearchProviderSchema,
  webSearchSettingsRequestSchema,
} from '../../contracts/web-search-wire.js';
import type { WebSearchProvider } from '../../contracts/web-search-policy.js';
import { clearOAuthCookie } from './oauth.js';
import { oauthCallbackCsp, oauthCallbackPage } from './oauth-callback-page.js';
import { WebSearchFault } from './errors.js';
import type {
  WebSearchConnectionsApi, WebSearchModuleOptions, WebSearchOAuthApi,
} from './types.js';

export const WEB_SEARCH_CONNECTIONS = Symbol('WEB_SEARCH_CONNECTIONS');
export const WEB_SEARCH_OAUTH = Symbol('WEB_SEARCH_OAUTH');
export const WEB_SEARCH_PRINCIPAL = Symbol('WEB_SEARCH_PRINCIPAL');
export const WEB_SEARCH_OVERRIDES = Symbol('WEB_SEARCH_OVERRIDES');
export const WEB_SEARCH_OPTIONS = Symbol('WEB_SEARCH_OPTIONS');

function errorBody(code: keyof typeof WEB_SEARCH_HTTP_ERRORS, currentRevision: number | null) {
  return webSearchHttpErrorSchema.parse({
    protocolVersion: 1,
    error: { code, retryable: WEB_SEARCH_HTTP_ERRORS[code].retryable, currentRevision },
  });
}

@Catch()
export class WebSearchFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) {
      if (!res.destroyed && !res.writableEnded) res.end();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (error instanceof AuthFault) {
      res.status(error.status).json(error.body());
      return;
    }
    if (error instanceof WebSearchFault) {
      res.status(WEB_SEARCH_HTTP_ERRORS[error.code].status)
        .json(errorBody(error.code, error.currentRevision));
      return;
    }
    if (error instanceof ZodError) {
      res.status(400).json(errorBody('WEB_INVALID_REQUEST', null));
      return;
    }
    if (error instanceof AppError) {
      const code = error.code === 'INPUT_TOO_LARGE' || error.code === 'STORAGE_BUDGET_EXCEEDED'
        ? 'WEB_INPUT_TOO_LARGE'
        : error.code === 'RATE_LIMITED' || error.code === 'CONCURRENCY_LIMIT'
          ? 'WEB_RATE_LIMITED'
          : error.code === 'TIMEOUT' ? 'WEB_SETUP_TIMEOUT'
            : error.code === 'PERSISTENCE_ERROR' || error.code === 'NOT_READY'
              ? 'WEB_STORAGE_UNAVAILABLE'
              : error.code === 'IDENTITY_OVERRIDE_REJECTED'
                || error.code === 'MODEL_OVERRIDE_REJECTED'
                || error.code === 'INVALID_REQUEST' || error.code === 'UNKNOWN_FIELD'
                ? 'WEB_INVALID_REQUEST' : 'WEB_PROVIDER_UNAVAILABLE';
      res.status(WEB_SEARCH_HTTP_ERRORS[code].status).json(errorBody(code, null));
      return;
    }
    res.status(WEB_SEARCH_HTTP_ERRORS.WEB_PROVIDER_UNAVAILABLE.status)
      .json(errorBody('WEB_PROVIDER_UNAVAILABLE', null));
  }
}

function abortOf(req: Request, res: Response): AbortSignal {
  const controller = new AbortController();
  const aborted = () => controller.abort();
  const closed = () => {
    if (!req.complete) controller.abort();
  };
  const cleanup = () => {
    req.off('aborted', aborted);
    req.off('close', closed);
    res.off('finish', cleanup);
    res.off('close', cleanup);
  };
  req.on('aborted', aborted);
  req.on('close', closed);
  res.on('finish', cleanup);
  res.on('close', cleanup);
  return controller.signal;
}

function assertNoQuery(req: Request): void {
  if ((req.url ?? '').includes('?')) throw new WebSearchFault('WEB_INVALID_REQUEST');
}

@Controller('plugins/web-search')
@UseFilters(WebSearchFilter)
export class WebSearchController {
  constructor(
    @Inject(WEB_SEARCH_CONNECTIONS) private readonly connections: () => WebSearchConnectionsApi,
    @Inject(WEB_SEARCH_OAUTH) private readonly oauth: () => WebSearchOAuthApi,
    @Inject(WEB_SEARCH_PRINCIPAL) private readonly principal: () => AuthPrincipal,
    @Inject(WEB_SEARCH_OVERRIDES) private readonly overrides: WebSearchModuleOptions['assertNoClientOverrides'],
    @Inject(WEB_SEARCH_OPTIONS) private readonly options: WebSearchModuleOptions,
  ) {}

  private userId(): string {
    return this.principal().identity.userId;
  }

  private provider(value: string | string[] | undefined): WebSearchProvider {
    if (typeof value !== 'string') throw new WebSearchFault('WEB_INVALID_REQUEST');
    return webSearchProviderSchema.parse(value);
  }

  @Get('status')
  async status(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    assertNoQuery(req);
    const connections = this.connections();
    const userId = this.userId();
    await connections.warmOwner(userId);
    // Opening the Plugins page is control-plane: restore API-key sessions so
    // the next chat turn can advertise web_tool without waiting for /auth/me.
    await connections.prepareApiKeySessions(userId, abortOf(req, res));
    return connections.status(userId);
  }

  @Patch('settings')
  async settings(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    assertNoQuery(req);
    this.overrides(body);
    const parsed = webSearchSettingsRequestSchema.parse(body);
    const signal = abortOf(req, res);
    const status = await this.connections().settings(this.userId(), parsed, signal);
    if (parsed.enabled) {
      // Enabling must make the next chat turn advertise web_tool, not just
      // persist the preference: restore and revalidate API-key MCP sessions
      // now, then report effective availability after that work.
      await this.connections().prepareApiKeySessions(this.userId(), signal);
      void this.oauth().maintainOwner(this.userId(), signal).catch(() => undefined);
      return this.connections().status(this.userId());
    }
    return status;
  }

  @Post('providers/:provider/connect')
  @HttpCode(200)
  async connect(
    @Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response,
  ) {
    assertNoQuery(req);
    this.overrides(body);
    const provider = this.provider(req.params.provider);
    const parsed = webSearchConnectRequestSchema.parse(body);
    return this.connections().connect(this.userId(), provider, parsed, abortOf(req, res));
  }

  @Post('providers/:provider/disconnect')
  @HttpCode(200)
  async disconnect(
    @Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response,
  ) {
    assertNoQuery(req);
    this.overrides(body);
    const provider = this.provider(req.params.provider);
    const parsed = webSearchDisconnectRequestSchema.parse(body);
    return this.connections().disconnect(this.userId(), provider, parsed, abortOf(req, res));
  }

  @Post('providers/:provider/oauth/start')
  @HttpCode(200)
  async oauthStart(
    @Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response,
  ) {
    assertNoQuery(req);
    this.overrides(body);
    const provider = this.provider(req.params.provider);
    const parsed = webSearchOAuthStartRequestSchema.parse(body);
    const result = await this.oauth().start(this.principal(), provider, parsed, abortOf(req, res));
    res.append('Set-Cookie', result.browserCookie);
    return webSearchOAuthStartResponseSchema.parse({
      protocolVersion: 1, authorizationUrl: result.authorizationUrl, expiresAt: result.expiresAt,
    });
  }

  @Get('providers/:provider/oauth/callback')
  callback(@Req() req: Request, @Res() res: Response) {
    const provider = this.provider(req.params.provider);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', oauthCallbackCsp(provider));
    res.type('html').send(oauthCallbackPage(provider));
  }

  @Post('providers/:provider/oauth/complete')
  @HttpCode(200)
  async oauthComplete(
    @Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response,
  ) {
    assertNoQuery(req);
    this.overrides(body);
    const provider = this.provider(req.params.provider);
    const parsed = webSearchOAuthCompleteRequestSchema.parse(body);
    const outcome = await this.oauth().complete(this.principal(), provider, {
      rawQuery: parsed.rawQuery,
      cookieHeader: typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined,
    }, abortOf(req, res));
    res.append('Set-Cookie', clearOAuthCookie(provider, this.options.secureCookie));
    return webSearchOAuthCompleteResponseSchema.parse({ protocolVersion: 1, outcome });
  }
}

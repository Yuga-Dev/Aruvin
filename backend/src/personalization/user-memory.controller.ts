/**
 * ============================================================================
 * FILE: user-memory.controller.ts
 * LOCATION: backend/src/personalization/user-memory.controller.ts
 * PURPOSE: Expose authenticated owner-scoped memory management.
 * ROLE IN PROJECT: Projects the Personalization memory API without trusting inputs as identity.
 * KEY COMPONENTS: Memory, enable, edit, clear, section edit and history routes; server identity; closed errors.
 * ============================================================================
 */
import { Body, Catch, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Res, UseFilters,
  type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { AuthFault } from '../auth/errors.js';
import { USER_MEMORY_ROUTES, userMemoryClearRequestSchema, userMemoryEditRequestSchema, userMemoryEnabledRequestSchema,
  userMemoryHistoryQuerySchema, userMemorySectionEditRequestSchema, userMemorySectionKeySchema,
  type UserMemoryEditResponse, type UserMemoryHistoryResponse, type UserMemoryResponse } from '../contracts/user-memory.js';
import { UserMemoryFault } from './errors.js';
import { MemoryWriterService } from './memory-writer.js';
import { PERSONALIZATION_USER_ID } from './personalization.controller.js';
import { UserMemoryService } from './user-memory.service.js';

@Catch()
class UserMemoryFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.end(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const fault = error instanceof AuthFault || error instanceof UserMemoryFault
      ? error : new UserMemoryFault('PERSISTENCE_ERROR');
    res.status(fault.status).json(fault.body());
  }
}

@Controller(USER_MEMORY_ROUTES.memory)
@UseFilters(UserMemoryFilter)
export class UserMemoryController {
  constructor(
    @Inject(PERSONALIZATION_USER_ID) private readonly resolveUserId: () => string,
    @Inject(UserMemoryService) private readonly memory: UserMemoryService | null,
    @Inject(MemoryWriterService) private readonly writer: MemoryWriterService | null,
  ) {}

  @Get()
  get(): Promise<UserMemoryResponse> {
    const userId = this.resolveUserId();
    return this.requireMemory().read(userId);
  }

  @Patch('enabled')
  setEnabled(@Body() body: unknown): Promise<UserMemoryResponse> {
    const userId = this.resolveUserId();
    const parsed = userMemoryEnabledRequestSchema.safeParse(body);
    if (!parsed.success) throw new UserMemoryFault('INVALID_REQUEST');
    return this.requireMemory().setEnabled(userId, parsed.data.expectedRevision, parsed.data.enabled,
      parsed.data.requestId);
  }

  @Post('edit')
  @HttpCode(200)
  async edit(@Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<UserMemoryEditResponse> {
    const userId = this.resolveUserId();
    const parsed = userMemoryEditRequestSchema.safeParse(body);
    if (!parsed.success) throw new UserMemoryFault('INVALID_REQUEST');
    if (!this.writer) throw new UserMemoryFault('MEMORY_WRITER_UNAVAILABLE');
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnect);
    if (res.destroyed) disconnect();
    try {
      const result = await this.writer.applyInstruction(userId, parsed.data.instruction, {
        source: 'composer', expectedRevision: parsed.data.expectedRevision, requestId: parsed.data.requestId,
        signal: controller.signal,
      });
      return { ...result.memory, changeSummary: result.changeSummary };
    } finally {
      res.off('close', disconnect);
    }
  }

  @Post('clear')
  @HttpCode(200)
  clear(@Body() body: unknown): Promise<UserMemoryResponse> {
    const userId = this.resolveUserId();
    const parsed = userMemoryClearRequestSchema.safeParse(body);
    if (!parsed.success) throw new UserMemoryFault('INVALID_REQUEST');
    return this.requireMemory().clear(userId, parsed.data.expectedRevision, parsed.data.requestId);
  }

  @Patch('sections/:key')
  editSection(@Param('key') key: string, @Body() body: unknown): Promise<UserMemoryResponse> {
    const userId = this.resolveUserId();
    const section = userMemorySectionKeySchema.safeParse(key);
    const parsed = userMemorySectionEditRequestSchema.safeParse(body);
    if (!section.success || !parsed.success) throw new UserMemoryFault('INVALID_REQUEST', null,
      !parsed.success && parsed.error.issues.some(issue => issue.message === 'secret_pattern'));
    return this.requireMemory().editSection(userId, parsed.data.expectedRevision, section.data,
      parsed.data.text, parsed.data.requestId);
  }

  @Get('history')
  history(@Query() query: unknown): Promise<UserMemoryHistoryResponse> {
    const userId = this.resolveUserId();
    const parsed = userMemoryHistoryQuerySchema.safeParse(query);
    if (!parsed.success) throw new UserMemoryFault('INVALID_REQUEST');
    return this.requireMemory().history(userId, parsed.data);
  }

  private requireMemory(): UserMemoryService {
    if (!this.memory) throw new UserMemoryFault('NOT_READY');
    return this.memory;
  }
}

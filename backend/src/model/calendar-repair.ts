/**
 * ============================================================================
 * FILE: calendar-repair.ts
 * LOCATION: backend/src/model/calendar-repair.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Instruction generation and native message reconstruction for calendar tool repairs.
 *
 * ROLE IN PROJECT:
 *    Constructs repair system prompts from validation diagnostics, preserves completed
 *    native assistant/tool pairs across turns, and validates historical call structure.
 *
 * KEY COMPONENTS:
 *    - repairInstruction: Generates structured instructions from bounded diagnostics.
 *    - assertNativeHistory: Validates native message sequence and tool-call pairs.
 *    - rebuildCalendarMessages: Reconstructs native history boundary for model decisions.
 * ============================================================================
 */

import { z } from 'zod';
import { completeToolGroupSchema, completeToolGroupV2Schema, nativeModelMessageSchema, repairDiagnosticsSchema,
  type CalendarDecisionRequest, type CalendarRepairDiagnostics,
  type CompleteCalendarToolGroup, type NativeCalendarModelMessage } from '../contracts/calendar-model.js';
import { webToolGroupSchema, type WebToolGroup } from '../chat-runtime/memory-web-state.js';
import {
  activateSkillEnvelopeSchema,
  callToolEnvelopeSchema,
  controlCanvasEnvelopeSchema,
  getEnvironmentEnvelopeSchema,
  historicalSkillNativeNameSchema,
  showCanvasEnvelopeSchema,
} from '../contracts/calendar-tools.js';
import { CALENDAR_LIMITS } from '../contracts/calendar-policy.js';
import { UPDATE_USER_MEMORY_TOOL_NAME, updateUserMemoryArgumentsSchema, updateUserMemoryReceiptSchema }
  from '../contracts/user-memory.js';
import { scanJsonObject } from './strict-json.js';

export function repairInstruction(input: CalendarRepairDiagnostics): string {
  const diagnostics = JSON.stringify(repairDiagnosticsSchema.parse(input));
  const needsSchema = input.some(item => item.code === 'schema-not-loaded' || item.code === 'schema-stale');
  const canvas = input.some(item => item.path === 'canvas_id'
    || item.path === 'action' || item.path === 'direction' || item.path === 'state');
  const env = input.some(item => item.path === 'include'
    || item.path === 'forecast_days' || item.path === 'units');
  const redundant = input.some(item => item.code === 'redundant-call');
  const openCanvasFirst = input.some(item => item.code === 'redundant-call' && item.expected === 'open-canvas-first');
  const effect = needsSchema
    ? 'This rejected call was not executed. Call activate_skill for the identified plugin and tool, then retry call_tool using the revealed schema.'
    : canvas
    ? 'This rejected decision performed no presentation action. Call control_canvas once matching the advertised control_canvas action schema.'
    : env
    ? 'This rejected decision performed no environment lookup. Call get_environment once with a non-empty unique include array of datetime, location, and/or weather.'
    : openCanvasFirst
    ? 'This rejected call was not executed because Canvas is currently closed (open is false). Do not claim Canvas is open or fullscreen; answer from that state instead of repeating it, or call control_canvas with action "open" and a canvas_id from canvas_ids first.'
    : redundant
    ? 'This rejected call was not executed. Its earlier successful result or current state is already present; answer from that state instead of repeating it.'
    : input.some(item => item.code === 'cardinality')
    ? 'You emitted more than one tool call. Emit exactly one native tool call, then wait. List events for one calendar per decision; after that result you may call again for another calendar.'
    : 'This rejected decision performed no Canvas navigation and no calendar write.';
  return `Correct the previous invalid tool decision using the advertised tools. Validation errors: ${diagnostics}. Use only the native tool-call format. For call_tool, validate arguments against the retained disclosed schema; an advertised wrapper is not the plugin argument schema. For pageToken, omit initially or copy the exact nextPageToken from that tool. Do not switch tools or accounts to bypass denials. ${effect}`;
}

export type CompositeNativeMessage =
  | NativeCalendarModelMessage
  | WebToolGroup['assistant']
  | WebToolGroup['result'];

function isWebNativeMessage(message: CompositeNativeMessage): boolean {
  return (message.role === 'assistant' && 'tool_calls' in message
      && (message.tool_calls[0]?.function.name as string) === 'web_tool')
    || (message.role === 'tool' && message.name === 'web_tool');
}

export function assertNativeHistory(input: readonly CompositeNativeMessage[]): void {
  const ids = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const candidate = input[i]!;
    if (candidate.role === 'assistant' && 'tool_calls' in candidate
      && (candidate.tool_calls[0]?.function.name as string) === 'web_tool') {
      const result = input[++i];
      webToolGroupSchema.parse({ ordinal: 0, afterCalendarGroups: 0,
        assistant: candidate, result, sources: [] });
      continue;
    }
    const message = nativeModelMessageSchema.parse(candidate);
    if (message.role === 'tool') throw new Error('Unmatched native result.');
    if ('tool_calls' in message) {
      const result = input[++i];
      const parsed = completeToolGroupV2Schema.safeParse({ assistant: message, result, sources: [] });
      const group = parsed.success ? parsed.data : completeToolGroupSchema.parse({ assistant: message, result, sources: [] });
      const id = group.assistant.tool_calls[0].id;
      if (ids.has(id)) throw new Error('Duplicate native call identity.');
      const call = group.assistant.tool_calls[0];
      const scan = scanJsonObject(call.function.arguments, CALENDAR_LIMITS);
      if (scan.code || scan.forbidden) throw new Error('Invalid native history call.');
      const args: unknown = JSON.parse(call.function.arguments);
      if (call.function.name === UPDATE_USER_MEMORY_TOOL_NAME) {
        if (group.sources.length) throw new Error('Unexpected memory tool sources.');
        updateUserMemoryArgumentsSchema.parse(args);
        updateUserMemoryReceiptSchema.parse(JSON.parse(group.result.content) as unknown);
      } else if (historicalSkillNativeNameSchema.safeParse(call.function.name).success) {
        const schema = call.function.name === 'activate_skill' ? activateSkillEnvelopeSchema
          : call.function.name === 'show_canvas' ? showCanvasEnvelopeSchema
          : call.function.name === 'control_canvas' ? controlCanvasEnvelopeSchema
          : call.function.name === 'get_environment' ? getEnvironmentEnvelopeSchema
          : callToolEnvelopeSchema;
        schema.parse(args);
      }
      ids.add(id);
    }
  }
}

export type CompleteCalendarToolGroupV2 = z.infer<typeof completeToolGroupV2Schema>;
export type CalendarHistoryBoundary = {
  prefix: readonly CompositeNativeMessage[];
  acceptedInput: { role: 'user'; content: string };
  groups: readonly (CompleteCalendarToolGroup | CompleteCalendarToolGroupV2)[];
};
export function rebuildCalendarMessages(boundary: CalendarHistoryBoundary,
  repair: CalendarDecisionRequest['repair'], note?: string | null): CompositeNativeMessage[] {
  const messages: CompositeNativeMessage[] = boundary.prefix.map(m =>
    isWebNativeMessage(m) ? m : nativeModelMessageSchema.parse(m));
  assertNativeHistory(messages);
  if (boundary.acceptedInput.role !== 'user') throw new Error('Accepted input must be user text.');
  messages.push(nativeModelMessageSchema.parse(boundary.acceptedInput));
  for (const input of boundary.groups) {
    const parsed = completeToolGroupV2Schema.safeParse(input);
    const group = parsed.success ? parsed.data : completeToolGroupSchema.parse(input);
    messages.push(group.assistant, group.result);
  }
  if (repair) messages.push({ role: 'system', content: repairInstruction(repair.diagnostics) });
  if (note) messages.push({ role: 'system', content: note.slice(0, 4000) });
  assertNativeHistory(messages);
  return messages;
}

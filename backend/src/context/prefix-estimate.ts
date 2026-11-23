/**
 * ============================================================================
 * FILE: prefix-estimate.ts
 * LOCATION: backend/src/context/prefix-estimate.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Compute the deterministic fixed-prefix estimate and derived context floor.
 *
 * ROLE IN PROJECT:
 *    Gives configuration validation, the public admin projection, and runtime
 *    admission one I/O-free byte-based estimate for the worst-case prompt prefix.
 *    The estimator is conservative and is not a provider tokenizer.
 *
 * KEY COMPONENTS:
 *    - computeChatFloor: Prefix + history + output + margin minimum, with breakdown.
 *    - assertChatFloor: Fail-closed configuration check with an actionable message.
 *    - worstCasePrefix: Fixed assets, max personalization, sample environment, mode, tools.
 * ============================================================================
 */

import type { ChatFloor, ChatLimits } from '../contracts/admin-config-wire.js';
import { MAX_CUSTOM_INSTRUCTIONS_CHARS,
  type UserPersonalizationSettings } from '../contracts/personalization.js';
import { SKILL_NATIVE_TOOLS } from '../contracts/calendar-tools.js';
import { WEB_TOOL_DEFINITION } from '../contracts/web-search-tools.js';
import { UPDATE_USER_MEMORY_TOOL_DEFINITION, USER_MEMORY_MAX_BYTES, USER_MEMORY_MAX_CHARS }
  from '../contracts/user-memory.js';
import type { EnvironmentContext } from '../contracts/context.js';
import type { FixedAssets } from '../instructions/fixed-assets.js';
import { nativeToolDefinitions } from '../model/calendar-policy.js';
import { AppError } from '../platform/errors/app-error.js';
import {
  environmentContextMessage,
  estimateMessagesTokens,
  fixedContextMessages,
  responseModeMessage,
  userMemoryMessage,
  userPersonalizationMessage,
} from './context-budget.js';

export type ChatFloorSettings = Pick<ChatLimits,
  'maxContextTokens' | 'maxHistoryTokens' | 'maxOutputTokens' | 'modelMarginTokens'>;

/**
 * Fixed sample environment so the estimate never changes with the calendar day.
 * Long IANA zone and weekday strings keep the sample conservative.
 */
const SAMPLE_ENVIRONMENT: EnvironmentContext = Object.freeze({
  timeZone: 'America/Argentina/ComodRivadavia',
  currentDate: '2026-12-31',
  dayOfWeek: 'Wednesday',
});

/**
 * Maximum admitted custom instructions in both character and UTF-8 byte terms:
 * 1,500 four-byte characters reach the 6,000-byte ceiling.
 */
const MAX_PERSONALIZATION: UserPersonalizationSettings = Object.freeze({
  warmth: 'medium',
  enthusiasm: 'medium',
  emoji: 'medium',
  customInstructions: '\u{1F600}'.repeat(MAX_CUSTOM_INSTRUCTIONS_CHARS),
  location: null,
});

/** The floor reserves even tools that a given turn does not advertise. */
const WORST_CASE_TOOLS = Object.freeze([
  ...nativeToolDefinitions(SKILL_NATIVE_TOOLS),
  WEB_TOOL_DEFINITION,
  UPDATE_USER_MEMORY_TOOL_DEFINITION,
]);

// For each well-formed, admitted code point, 3 * JSON bytes <= 2 * UTF-8 bytes + 4:
// escapable ASCII costs at most 2 JSON bytes, and all other points at most 4.
// The pin schema rejects long-escaped controls; the renderer repairs lone surrogates.
const MAX_MEMORY_JSON_BYTES = Math.floor((2 * USER_MEMORY_MAX_BYTES + 4 * USER_MEMORY_MAX_CHARS) / 3);
const MAX_MEMORY_MESSAGE_TOKENS =
  estimateMessagesTokens([userMemoryMessage('x')!]) - 1 + MAX_MEMORY_JSON_BYTES;

type PrefixEstimate = Pick<ChatFloor, 'prefixTokens' | 'breakdown'>;

function estimatePrefix(assets: FixedAssets): PrefixEstimate {
  const [systemMessage, productMessage] = fixedContextMessages(assets);
  const personalizationMessage = userPersonalizationMessage(MAX_PERSONALIZATION);
  const textMode = responseModeMessage('text');
  const voiceMode = responseModeMessage('voice');
  const modeMessage = estimateMessagesTokens([voiceMode]) >= estimateMessagesTokens([textMode])
    ? voiceMode : textMode;
  const fixedMessages = [
    systemMessage!, productMessage!, environmentContextMessage(SAMPLE_ENVIRONMENT), modeMessage,
  ];
  // Allocate the 256-token global prompt framing to the prefix. History uses the
  // shared estimator without that framing so the total stays consistent.
  const fixed = estimateMessagesTokens(fixedMessages) + 256;
  const personalization = (personalizationMessage
    ? estimateMessagesTokens([personalizationMessage]) : 0) + MAX_MEMORY_MESSAGE_TOKENS;
  const tools = Buffer.byteLength(JSON.stringify(WORST_CASE_TOOLS), 'utf8');
  return {
    prefixTokens: fixed + personalization + tools,
    breakdown: { fixed, personalization, tools },
  };
}

export function computeChatFloor(assets: FixedAssets, chat: ChatFloorSettings): ChatFloor {
  const prefix = estimatePrefix(assets);
  return {
    minContextTokens: prefix.prefixTokens + chat.maxHistoryTokens +
      chat.maxOutputTokens + chat.modelMarginTokens,
    prefixTokens: prefix.prefixTokens,
    breakdown: prefix.breakdown,
    historyTokens: chat.maxHistoryTokens,
    reserves: {
      maxOutputTokens: chat.maxOutputTokens,
      modelMarginTokens: chat.modelMarginTokens,
    },
  };
}

/**
 * Reject a context total below the floor computed from the loaded assets. The
 * message names the minimum and its breakdown; the admin protocol exposes the
 * same numbers through PublicAdminConfig.chatFloor rather than free text.
 */
export function assertChatFloor(assets: FixedAssets, chat: ChatFloorSettings): ChatFloor {
  const floor = computeChatFloor(assets, chat);
  if (chat.maxContextTokens < floor.minContextTokens) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      `maxContextTokens must be at least ${floor.minContextTokens}: prefix ` +
        `${floor.prefixTokens} (fixed ${floor.breakdown.fixed} + personalization ` +
        `${floor.breakdown.personalization} + tools ${floor.breakdown.tools}), history ` +
        `${floor.historyTokens}, output ${floor.reserves.maxOutputTokens}, margin ` +
        `${floor.reserves.modelMarginTokens}. Raise maxContextTokens or lower maxHistoryTokens.`,
    );
  }
  return floor;
}

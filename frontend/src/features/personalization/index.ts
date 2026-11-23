/**
 * ============================================================================
 * FILE: index.ts
 * LOCATION: frontend/src/features/personalization/index.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Barrel exports for the frontend personalization feature.
 *
 * ROLE IN PROJECT:
 *    Exposes EmotionSlider, LocationCard, PersonalizationPanel, and state helpers.
 *
 * KEY COMPONENTS:
 *    - EmotionSlider, LocationCard, PersonalizationPanel, personalizationReducer
 * ============================================================================
 */

export { EmotionSlider, type EmotionSliderProps } from './EmotionSlider.tsx';
export { LocationCard, type LocationCardProps } from './LocationCard.tsx';
export { PersonalizationPanel, type PersonalizationPanelProps } from './PersonalizationPanel.tsx';
export {
  BrowserGeolocationError,
  requestBrowserCoordinates,
  type BrowserCoordinates,
  type BrowserGeolocationErrorCode,
  type GeolocationLike,
} from './browser-geolocation.ts';
export {
  canResetToDefaults,
  clientInstructionsValidationError,
  clientLocationValidationError,
  clientValidationError,
  describeFieldError,
  initialPersonalizationState,
  isPersonalizationDirty,
  personalizationReducer,
  type LocationTextField,
  type PersonalizationAction,
  type PersonalizationBusy,
  type PersonalizationPhase,
  type PersonalizationState,
} from './personalization-state.ts';

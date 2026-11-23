/**
 * ============================================================================
 * FILE: index.ts
 * LOCATION: backend/src/environment/index.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Public exports for Aurvin's environment tool and weather provider module.
 *
 * ROLE IN PROJECT:
 *    Gives runtime, assembly, and tests one clean entry point for weather
 *    lookup services and get_environment execution helpers.
 *
 * KEY COMPONENTS:
 *    - OpenMeteoWeatherProvider / WeatherProvider: Cached weather provider.
 *    - executeEnvironmentTool / buildEnvironmentDatetime / resolveEnvironmentLocation.
 * ============================================================================
 */

export { wmoConditionLabel, WMO_WEATHER_LABELS } from './wmo-codes.js';
export {
  DEFAULT_FORECAST_TTL_MS,
  DEFAULT_GEOCODE_TTL_MS,
  DEFAULT_OPEN_METEO_FORECAST_URL,
  DEFAULT_OPEN_METEO_GEOCODING_URL,
  DEFAULT_WEATHER_CACHE_ENTRIES,
  DEFAULT_WEATHER_MAX_RESPONSE_BYTES,
  DEFAULT_WEATHER_TIMEOUT_MS,
  OpenMeteoWeatherProvider,
  type GeocodedLocation,
  type OpenMeteoWeatherProviderOptions,
  type WeatherLookupInput,
  type WeatherLookupResult,
  type WeatherLookupSuccess,
  type WeatherProvider,
} from './weather-service.js';
export {
  buildEnvironmentDatetime,
  executeEnvironmentTool,
  extractSavedLocation,
  resolveEnvironmentLocation,
  type EnvironmentExecutionResult,
  type EnvironmentSavedLocation,
  type ResolvedEnvironmentLocation,
} from './environment-tool.js';

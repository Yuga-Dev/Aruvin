/**
 * ============================================================================
 * FILE: browser-geolocation.ts
 * LOCATION: frontend/src/features/personalization/browser-geolocation.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Wrap navigator.geolocation.getCurrentPosition for one-time user-triggered
 *    coarse location detection with accessible error classification.
 *
 * ROLE IN PROJECT:
 *    Keeps browser geolocation access isolated, injectable for Node Vitest
 *    tests, and strictly click-driven (never called automatically on load).
 *
 * KEY COMPONENTS:
 *    - BrowserGeolocationError: Closed error codes and safe user messages.
 *    - requestBrowserCoordinates: Single-shot coarse coordinate request.
 * ============================================================================
 */

export type BrowserGeolocationErrorCode =
  | 'UNSUPPORTED'
  | 'PERMISSION_DENIED'
  | 'POSITION_UNAVAILABLE'
  | 'TIMEOUT';

export class BrowserGeolocationError extends Error {
  readonly code: BrowserGeolocationErrorCode;

  constructor(code: BrowserGeolocationErrorCode, message: string) {
    super(message);
    this.name = 'BrowserGeolocationError';
    this.code = code;
  }
}

export type GeolocationLike = Pick<Geolocation, 'getCurrentPosition'>;

export type BrowserCoordinates = {
  latitude: number;
  longitude: number;
};

const DEFAULT_GEOLOCATION_TIMEOUT_MS = 10_000;
const DEFAULT_GEOLOCATION_MAX_AGE_MS = 60_000;

export function requestBrowserCoordinates(
  geolocation: GeolocationLike | null | undefined,
  options?: { timeoutMs?: number },
): Promise<BrowserCoordinates> {
  if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') {
    return Promise.reject(
      new BrowserGeolocationError(
        'UNSUPPORTED',
        'Location detection is not supported in this browser. Enter your city manually.',
      ),
    );
  }

  return new Promise<BrowserCoordinates>((resolve, reject) => {
    geolocation.getCurrentPosition(
      position => {
        const latitude = position?.coords?.latitude;
        const longitude = position?.coords?.longitude;
        if (
          typeof latitude !== 'number' ||
          !Number.isFinite(latitude) ||
          typeof longitude !== 'number' ||
          !Number.isFinite(longitude)
        ) {
          reject(
            new BrowserGeolocationError(
              'POSITION_UNAVAILABLE',
              'Your location could not be determined. Try again or enter your city manually.',
            ),
          );
          return;
        }
        resolve({ latitude, longitude });
      },
      error => {
        if (error?.code === 1) {
          reject(
            new BrowserGeolocationError(
              'PERMISSION_DENIED',
              'Location access was denied. You can enter your city manually.',
            ),
          );
          return;
        }
        if (error?.code === 3) {
          reject(
            new BrowserGeolocationError(
              'TIMEOUT',
              'Location detection timed out. Try again or enter your city manually.',
            ),
          );
          return;
        }
        reject(
          new BrowserGeolocationError(
            'POSITION_UNAVAILABLE',
            'Your location could not be determined. Try again or enter your city manually.',
          ),
        );
      },
      {
        enableHighAccuracy: false,
        timeout: options?.timeoutMs ?? DEFAULT_GEOLOCATION_TIMEOUT_MS,
        maximumAge: DEFAULT_GEOLOCATION_MAX_AGE_MS,
      },
    );
  });
}

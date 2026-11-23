/**
 * ============================================================================
 * FILE: vitest.config.ts
 * LOCATION: benchmarks/voice-architectures/vitest.config.ts
 * PURPOSE: Run isolated deterministic Node checks without service discovery.
 * ROLE IN PROJECT: Never imports the backend build or starts live candidates.
 * KEY COMPONENTS: Explicit test glob; finite fixture deadlines.
 * ============================================================================
 */
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', include: ['**/__tests__/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'], testTimeout: 10_000, hookTimeout: 10_000 }
});

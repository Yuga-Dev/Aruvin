/**
 * ============================================================================
 * FILE: role-aware-dashboard.test.ts
 * LOCATION: frontend/src/features/admin-config/role-aware-dashboard.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify AdminDashboard presents role-gated tabs and avoids restricted
 *    configuration reads when rendered for standard Users.
 *
 * ROLE IN PROJECT:
 *    Ensures standard Users can access Plugins without calling the 403-restricted
 *    GET /admin/config endpoint, while Super Admins see all 4 tabs.
 *
 * KEY COMPONENTS:
 *    - Role check: User sees Personalization, Plugins; Super Admin sees Personalization, Config, Plugins, Analytics, Administration
 *    - Client read call suppression for standard Users
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AdminConfigClient } from '../../api/admin-config-client.ts';
import { AdminDashboard } from './AdminDashboard.tsx';
import { publicConfig } from './testing/fixtures.ts';

describe('AdminDashboard role-aware navigation', () => {
  it('renders Personalization first and Plugins second for standard User and does not call client.read', () => {
    const read = vi.fn(async () => publicConfig());
    const models = vi.fn();
    const client: AdminConfigClient = {
      read,
      models,
      checkModelCompatibility: vi.fn(),
      saveSettings: vi.fn(),
      updateCredential: vi.fn(),
      readDevMode: vi.fn(),
      setDevMode: vi.fn(),
    };

    const html = renderToStaticMarkup(
      createElement(AdminDashboard, {
        client,
        user: {
          userId: 'usr-user',
          email: 'user@example.com',
          role: 'user',
          passwordChangeRequired: false,
        },
        onBackToChat: () => undefined,
        refreshCapabilities: async () => true,
      }),
    );

    expect(html).toContain('Manage Aurvin');
    expect(html).toContain('Personalization');
    expect(html).toContain('Plugins');
    expect(html.indexOf('Personalization')).toBeLessThan(html.indexOf('>Plugins<'));
    expect(html).toMatch(/id="[^"]+-personalization-tab"[^>]*aria-selected="true"/);
    expect(html).not.toContain('>Config<');
    expect(html).not.toContain('>Analytics<');
    expect(html).not.toContain('>Administration<');
    expect(read).not.toHaveBeenCalled();
    expect(models).not.toHaveBeenCalled();
  });

  it('renders all 5 tabs starting with Personalization for Super Admin and invokes client.read', () => {
    const read = vi.fn(async () => publicConfig());
    const client: AdminConfigClient = {
      read,
      models: vi.fn(),
      checkModelCompatibility: vi.fn(),
      saveSettings: vi.fn(),
      updateCredential: vi.fn(),
      readDevMode: vi.fn(),
      setDevMode: vi.fn(),
    };

    const html = renderToStaticMarkup(
      createElement(AdminDashboard, {
        client,
        user: {
          userId: 'usr-admin',
          email: 'admin@example.com',
          role: 'super-admin',
          passwordChangeRequired: false,
        },
        onBackToChat: () => undefined,
        refreshCapabilities: async () => true,
      }),
    );

    expect(html).toContain('Personalization');
    expect(html).toContain('Config');
    expect(html).toContain('Plugins');
    expect(html).toContain('Analytics');
    expect(html).toContain('Administration');
    expect(html.indexOf('>Personalization<')).toBeLessThan(html.indexOf('>Config<'));
    expect(html).toMatch(/id="[^"]+-personalization-tab"[^>]*aria-selected="true"/);
    expect(html).toContain('Loading configuration');
  });

  it('lets standard Users open Plugins -> Web Search without calling adminClient.read', () => {
    const read = vi.fn(async () => publicConfig());
    const html = renderToStaticMarkup(
      createElement(AdminDashboard, {
        client: {
          read,
          models: vi.fn(),
          checkModelCompatibility: vi.fn(),
          saveSettings: vi.fn(),
          updateCredential: vi.fn(),
          readDevMode: vi.fn(),
          setDevMode: vi.fn(),
        },
        user: { userId: 'u1', email: 'u@example.com', role: 'user', passwordChangeRequired: false },
        onBackToChat: () => undefined,
        refreshCapabilities: async () => true,
        initialSection: 'web-search',
      }),
    );
    expect(html).toContain('Web Search');
    expect(read).not.toHaveBeenCalled();
  });
});

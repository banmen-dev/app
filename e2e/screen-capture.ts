import type { BrowserContext, Page } from '@playwright/test';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { operationPath } from '../src/shared/operations/define.ts';
import { meThemeUpdate } from '../src/shared/operations/organization/me-theme-update.ts';
import { isLoopbackHttpOrigin, sessionCookieName } from '../src/shared/session-cookie.ts';

export const CAPTURE_THEMES = ['simple_light', 'simple_dark', 'modern'] as const;
export type CaptureTheme = (typeof CAPTURE_THEMES)[number];

export const DESKTOP_VIEWPORT = { width: 1280, height: 900 };
export const NARROW_VIEWPORT = { width: 390, height: 844 };
export type CaptureViewport = typeof DESKTOP_VIEWPORT;

export async function addSeedSessionCookie(
  context: BrowserContext,
  origin: string,
  who: keyof typeof SEED_SESSIONS,
): Promise<void> {
  await context.addCookies([
    { name: sessionCookieName(origin), value: SEED_SESSIONS[who].token, url: origin, httpOnly: true },
  ]);
}

export async function setSeedTheme(context: BrowserContext, origin: string, theme: CaptureTheme): Promise<void> {
  if (!isLoopbackHttpOrigin(origin)) throw new Error('テーマを変更できるのはローカルの開発・テスト先だけです');
  const response = await context.request.post(new URL(operationPath(meThemeUpdate, 'aoba'), origin).href, {
    headers: { Origin: new URL(origin).origin },
    data: { theme },
    maxRedirects: 0,
  });
  const body = response.ok() ? meThemeUpdate.output.safeParse(await response.json()) : undefined;
  if (!body?.success || body.data.theme !== theme)
    throw new Error(`テーマの保存を確認できません（${theme}、HTTP ${response.status()}）`);
}

export async function setCaptureViewport(page: Page, viewport: CaptureViewport): Promise<void> {
  const { width } = viewport;
  let actual = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.setViewportSize(viewport);
    actual = await page.evaluate(() => window.innerWidth);
    if (actual === width) return;
  }
  throw new Error(`画面幅が ${width}px になりません（2回目: ${actual}px）`);
}

export async function captureScreen(
  page: Page,
  viewport: CaptureViewport,
  theme: CaptureTheme,
  path: string,
): Promise<void> {
  await setCaptureViewport(page, viewport);
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
  await page.screenshot({ path, fullPage: true, animations: 'disabled', scale: 'css' });
}

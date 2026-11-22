import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errors, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { DESKTOP_VIEWPORT, setCaptureViewport, type CaptureTheme } from '../e2e/screen-capture.ts';
import { operationPath } from '../src/shared/operations/define.ts';
import { epicDetail } from '../src/shared/operations/epic/epic-detail.ts';
import { storyComplete } from '../src/shared/operations/story/story-complete.ts';
import { word } from '../src/shared/vocabulary.ts';

type MotionOptions = {
  browser: Browser;
  origin: string;
  fixedTime: Date;
  outputDir: string;
  resetSeed: () => Promise<void>;
  themes: readonly CaptureTheme[];
  signIn: (context: BrowserContext, origin: string, who: 'admin' | 'member') => Promise<void>;
  setTheme: (context: BrowserContext, origin: string, theme: CaptureTheme) => Promise<void>;
  composeFrames: (frames: string[], labels: string[], output: string) => Promise<void>;
};

type EffectName = 'stamp' | 'toast' | 'clear';
type AnimationTiming = {
  effect: EffectName;
  name: string;
  element: string;
  durationMs: number | null;
  iterations: number | null;
};
type MotionWindow = Window & { screenReviewAnimations?: Map<Animation, AnimationTiming> };
type FrameTarget = { effect: EffectName; area: Locator };
type MotionCase = 'task-complete' | 'epic-clear';
type Media = 'no-preference' | 'reduce';

const slug = 'aoba';
const workspaceId = '019a0000-0000-7000-8000-000000000401';
const epicId = '019a0000-0000-7000-8000-000000000b01';
const taskTitle = '障害時の連絡手順を書く';
const framePositions = [0, 0.15, 0.5, 1];
// 動きを減らす設定で許容する、ごく短い変化の上限。
const maxReducedDurationMs = 50;

// reduce では成果を表示する範囲を、その子孫の動きも含めて観測する。
const motionScopes = { stamp: '.entry.is-done', toast: '.toasts', clear: '.celebrate' } as const;

export function motionAnimationSelectors(media: Media) {
  return media === 'no-preference'
    ? { stamp: '.hanko', toast: '.toast', clear: '.celebrate-stamp' }
    : {
        stamp: `${motionScopes.stamp}, ${motionScopes.stamp} *`,
        toast: `${motionScopes.toast}, ${motionScopes.toast} *`,
        clear: `${motionScopes.clear}, ${motionScopes.clear} *`,
      };
}

export async function expectNoCelebration(celebration: Pick<Locator, 'waitFor'>) {
  // 通常のクリア演出の長さ（420ms）を超えるまで、遅れて出る要素も監視する。
  try {
    await celebration.waitFor({ state: 'attached', timeout: 500 });
  } catch (error) {
    if (error instanceof errors.TimeoutError) return;
    throw error;
  }
  throw new Error('動きを減らす設定でクリアの演出が表示されました');
}

async function watchAnimations(page: Page, media: Media) {
  const freeze = media === 'no-preference';
  const selectors = motionAnimationSelectors(media);
  await page.evaluate(
    ({ freeze, selectors }) => {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches === freeze) {
        throw new Error('動きを減らす設定がブラウザに反映されていません');
      }
      const animations = new Map<Animation, AnimationTiming>();
      (window as MotionWindow).screenReviewAnimations = animations;

      function observe() {
        for (const animation of document.getAnimations()) {
          if (animations.has(animation)) continue;
          const keyframes = animation.effect;
          if (!(keyframes instanceof KeyframeEffect) || !(keyframes.target instanceof Element)) continue;
          const target = keyframes.target;
          const effect = (Object.keys(selectors) as EffectName[]).find((effect) => target.matches(selectors[effect]));
          if (effect === undefined) continue;
          const { endTime, iterations } = keyframes.getComputedTiming();
          const name =
            animation instanceof CSSAnimation
              ? animation.animationName
              : animation instanceof CSSTransition
                ? animation.transitionProperty
                : 'Web Animation';
          animations.set(animation, {
            effect,
            name,
            element: [target.localName, ...target.classList].join('.'),
            durationMs: typeof endTime === 'number' && Number.isFinite(endTime) ? endTime : null,
            iterations: typeof iterations === 'number' && Number.isFinite(iterations) ? iterations : null,
          });
          if (freeze) animation.pause();
        }
      }
      function observeFrame() {
        observe();
        requestAnimationFrame(observeFrame);
      }
      // 操作の前から見張る。アプリの読み直しを待ってから探すと、短い演出は取り逃す。
      document.addEventListener('animationstart', observe);
      document.addEventListener('transitionrun', observe);
      requestAnimationFrame(observeFrame);
    },
    { freeze, selectors },
  );
}

async function readAnimationTimings(page: Page): Promise<AnimationTiming[]> {
  return page.evaluate(async () => {
    // 描画の直後に操作結果が見えた場合も、開始したフレームを記録してから読む。
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const animations = (window as MotionWindow).screenReviewAnimations;
    if (!animations) throw new Error('演出の観測を開始できていません');
    return Array.from(animations.values());
  });
}

async function startTaskCompletion(page: Page, origin: string, media: Media): Promise<FrameTarget[]> {
  await page.goto(`${origin}/${slug}`);
  await page
    .getByRole('button', { name: word('todayMarkLabel', { mark: word('todayMark'), title: taskTitle }), exact: true })
    .click();
  const today = page.getByRole('region', { name: word('sectionToday'), exact: true });
  await today.getByText(taskTitle, { exact: true }).waitFor();

  // 印を付けたときのトーストを消し、完了の操作で出る知らせだけを観測する。
  await page.reload();
  const complete = today.getByRole('button', {
    name: word('taskCompleteLabel', { complete: word('complete'), title: taskTitle }),
    exact: true,
  });
  await complete.waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await watchAnimations(page, media);
  await complete.click();

  const toast = page
    .locator('.toast:visible')
    .filter({ hasText: word('taskCompleted', { task: word('task'), done: word('done') }) });
  const row = page
    .getByRole('region', { name: word('doneToday'), exact: true })
    .locator(motionScopes.stamp)
    .filter({ has: page.getByText(taskTitle, { exact: true }) });
  const notices = page.locator(motionScopes.toast).filter({ has: toast });
  await notices.waitFor();
  await row.locator('.hanko').waitFor();
  return [
    { effect: 'toast', area: notices },
    { effect: 'stamp', area: row },
  ];
}

async function startEpicClear(page: Page, origin: string, media: Media): Promise<FrameTarget[]> {
  const headers = { Origin: origin };
  const detail = await page.request.post(`${origin}${operationPath(epicDetail, slug)}`, {
    headers,
    data: { workspace_id: workspaceId, epic_id: epicId },
    maxRedirects: 0,
  });
  if (!detail.ok()) throw new Error(`クリアの準備で ${epicDetail.name} が失敗しました (${detail.status()})`);
  const { stories } = epicDetail.output.parse(await detail.json());
  // seed のこのエピックは、配下のタスクは完了済みだがストーリーは未完了。
  for (const story of stories.filter((story) => story.completed_at === null)) {
    const response = await page.request.post(`${origin}${operationPath(storyComplete, slug)}`, {
      headers,
      data: { workspace_id: workspaceId, story_id: story.id },
      maxRedirects: 0,
    });
    if (!response.ok()) throw new Error(`クリアの準備で ${storyComplete.name} が失敗しました (${response.status()})`);
  }
  await page.goto(`${origin}/${slug}/w/${workspaceId}/epics/${epicId}`);
  const clear = page.getByRole('button', { name: word('clear'), exact: true });
  await clear.waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await watchAnimations(page, media);
  await clear.click();

  const celebration = page.locator(motionScopes.clear);
  const sheet = celebration.locator('.celebrate-sheet');
  if (media === 'no-preference') {
    await sheet.waitFor();
  } else {
    await page
      .locator(motionScopes.toast)
      .locator('.toast:visible')
      .filter({ hasText: word('epicClearedToastEmpty', { epic: word('epic'), done: word('done') }) })
      .waitFor();
    await expectNoCelebration(celebration);
  }
  return [{ effect: 'clear', area: sheet }];
}

async function captureEffect(
  page: Page,
  target: FrameTarget,
  timing: AnimationTiming,
  prefix: string,
): Promise<{ frames: string[]; labels: string[] }> {
  const area = await target.area.boundingBox();
  if (area === null || timing.durationMs === null) throw new Error(`${target.effect} の撮影範囲か時間を取得できません`);
  // 判子が拡大する範囲と、トーストが移動する範囲も含めて、全コマを同じ位置で切り出す。
  const margin = 16;
  const x = Math.max(0, Math.floor(area.x - margin));
  const y = Math.max(0, Math.floor(area.y - margin));
  const clip = {
    x,
    y,
    width: Math.min(DESKTOP_VIEWPORT.width, Math.ceil(area.x + area.width + margin)) - x,
    height: Math.min(DESKTOP_VIEWPORT.height, Math.ceil(area.y + area.height + margin)) - y,
  };
  const frames: string[] = [];
  const labels: string[] = [];
  for (const [index, position] of framePositions.entries()) {
    const currentTime = timing.durationMs * position;
    await page.evaluate(
      ({ effect, currentTime }) => {
        for (const [animation, sample] of (window as MotionWindow).screenReviewAnimations ?? []) {
          if (sample.effect === effect) animation.currentTime = currentTime;
        }
      },
      { effect: target.effect, currentTime },
    );
    const frame = `${prefix}-${index + 1}.png`;
    await page.screenshot({ path: frame, clip });
    frames.push(frame);
    labels.push(`${Math.round(currentTime)} ms`);
  }
  return { frames, labels };
}

export async function captureReviewMotion(options: MotionOptions): Promise<void> {
  const outputDir = join(options.outputDir, 'motion');
  await mkdir(outputDir, { recursive: true });
  const results: {
    theme: CaptureTheme;
    motion: MotionCase;
    media: Media;
    status: 'passed' | 'failed';
    timings: AnimationTiming[];
    error?: string;
  }[] = [];
  for (const theme of options.themes) {
    for (const motion of ['task-complete', 'epic-clear'] as const) {
      for (const media of ['no-preference', 'reduce'] as const) {
        const result: (typeof results)[number] = { theme, motion, media, status: 'passed', timings: [] };
        results.push(result);
        try {
          await options.resetSeed();
          const context = await options.browser.newContext({
            viewport: DESKTOP_VIEWPORT,
            reducedMotion: media,
            timezoneId: 'Asia/Tokyo',
            locale: 'ja-JP',
          });
          try {
            await options.signIn(context, options.origin, 'admin');
            await options.setTheme(context, options.origin, theme);
            const page = await context.newPage();
            await setCaptureViewport(page, DESKTOP_VIEWPORT);
            await page.clock.setFixedTime(options.fixedTime);
            const targets = await (motion === 'task-complete' ? startTaskCompletion : startEpicClear)(
              page,
              options.origin,
              media,
            );
            const [width, appliedTheme] = await page.evaluate(() => [
              innerWidth,
              document.documentElement.dataset.theme,
            ]);
            if (width !== DESKTOP_VIEWPORT.width || appliedTheme !== theme) {
              throw new Error(
                `演出の画面が ${theme} / ${DESKTOP_VIEWPORT.width}px になっていません (${appliedTheme} / ${width}px)`,
              );
            }
            result.timings = await readAnimationTimings(page);
            if (media === 'reduce') {
              const longMotion = result.timings.find(
                (timing) => timing.durationMs === null || timing.durationMs > maxReducedDurationMs,
              );
              if (longMotion) {
                throw new Error(
                  `動きを減らす設定で長い演出が流れました（${longMotion.element}、${longMotion.name}、${longMotion.durationMs ?? '時間不明'}ms）`,
                );
              }
              continue;
            }
            const strips = [];
            for (const target of targets) {
              const timings = result.timings.filter((timing) => timing.effect === target.effect);
              const [timing] = timings;
              if (
                timings.length !== 1 ||
                timing.durationMs === null ||
                timing.durationMs <= 0 ||
                timing.iterations !== 1
              ) {
                throw new Error(`${target.effect} の開始から終了までが1回の有限な演出になっていません`);
              }
              const prefix = join(outputDir, `${theme}-${target.effect}`);
              strips.push({ ...(await captureEffect(page, target, timing, prefix)), output: `${prefix}.png` });
            }
            for (const { frames, labels, output } of strips) {
              await options.composeFrames(frames, labels, output);
            }
          } finally {
            await context.close();
          }
        } catch (error) {
          result.status = 'failed';
          result.error = error instanceof Error ? error.message : String(error);
        }
      }
    }
  }
  await writeFile(join(outputDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  const failed = results.filter((result) => result.status === 'failed');
  if (failed.length > 0) {
    throw new Error(
      failed.map(({ theme, motion, media, error }) => `${theme} / ${motion} / ${media} ${error}`).join('\n'),
    );
  }
}

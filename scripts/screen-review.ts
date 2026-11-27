import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import {
  addSeedSessionCookie,
  CAPTURE_THEMES,
  captureScreen,
  DESKTOP_VIEWPORT,
  NARROW_VIEWPORT,
  setSeedTheme,
} from '../e2e/screen-capture.ts';
import { word } from '../src/shared/vocabulary.ts';
import { extractDesignRules } from './screen-review-design.ts';
import { composeContactSheet, composePair, frameComposer, referenceFontFailure } from './screen-review-images.ts';
import { captureReviewMotion } from './screen-review-motion.ts';
import { reviewCaptureTime, screenReviewOptions, screenReviewOutput } from './screen-review-options.ts';
import { launchChromium, localReviewRuntime, serveReference } from './screen-review-runtime.ts';

const PIN_TITLE = '障害時の連絡手順を書く';
const PINNED_LIST = '今日やると決めたもの';
const STATIC_OPTIONS: BrowserContextOptions = {
  locale: 'ja-JP',
  timezoneId: 'Asia/Tokyo',
  colorScheme: 'light',
  deviceScaleFactor: 1,
  reducedMotion: 'reduce',
};

async function appToday(page: Page, origin: string, fixedTime: Date) {
  await page.clock.setFixedTime(fixedTime);
  await page.goto(`${origin}/aoba`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: word('pageToday'), exact: true }).waitFor();
  await page.getByRole('heading', { level: 2, name: word('workspace'), exact: true }).waitFor();
  return page.getByRole('region', { name: word('sectionToday'), exact: true });
}

async function prepareToday(browser: Browser, origin: string, fixedTime: Date) {
  const context = await browser.newContext({ ...STATIC_OPTIONS, viewport: DESKTOP_VIEWPORT });
  try {
    await addSeedSessionCookie(context, origin, 'admin');
    const page = await context.newPage();
    const list = await appToday(page, origin, fixedTime);
    await page
      .getByRole('button', { name: word('todayMarkLabel', { mark: word('todayMark'), title: PIN_TITLE }), exact: true })
      .click();
    await list.getByText(PIN_TITLE, { exact: true }).waitFor();
  } finally {
    await context.close();
  }
}

async function captureToday(
  browser: Browser,
  appOrigin: string,
  referenceOrigin: string,
  directory: string,
  fixedTime: Date,
) {
  const originals = join(directory, 'originals');
  const pairs = join(directory, 'pairs');
  await Promise.all([mkdir(originals), mkdir(pairs)]);
  await prepareToday(browser, appOrigin, fixedTime);
  const comparison = await browser.newPage();
  const results = [];
  try {
    for (const theme of CAPTURE_THEMES) {
      for (const viewport of [DESKTOP_VIEWPORT, NARROW_VIEWPORT]) {
        const label = `${theme}-${viewport.width}`;
        const referenceFontFailures = new Set<string>();
        const appPath = join(originals, `${label}-app.png`);
        const referencePath = join(originals, `${label}-reference.png`);
        const appContext = await browser.newContext({ ...STATIC_OPTIONS, viewport });
        const referenceContext = await browser.newContext({ ...STATIC_OPTIONS, viewport });
        try {
          await addSeedSessionCookie(appContext, appOrigin, 'admin');
          await setSeedTheme(appContext, appOrigin, theme);
          const app = await appContext.newPage();
          const list = await appToday(app, appOrigin, fixedTime);
          await list.getByText(PIN_TITLE, { exact: true }).waitFor();
          await captureScreen(app, viewport, theme, appPath);
          if (await app.evaluate(() => Array.from(document.fonts).some((font) => font.status === 'error')))
            throw new Error(`実装のフォントを読み込めません（${label}）`);

          const reference = await referenceContext.newPage();
          const recordFontFailure = (url: string, status?: number) => {
            const failure = referenceFontFailure(url, status);
            if (failure) referenceFontFailures.add(failure);
          };
          reference.on('requestfailed', (request) => recordFontFailure(request.url()));
          reference.on('response', (response) => recordFontFailure(response.url(), response.status()));
          await reference.addInitScript((value) => localStorage.setItem('sq-design-theme', value), theme);
          await reference.goto(`${referenceOrigin}/today.html`, { waitUntil: 'domcontentloaded' });
          await reference.getByRole('heading', { level: 1, name: '今日やること', exact: true }).waitFor();
          await reference.getByRole('heading', { level: 3, name: PINNED_LIST }).waitFor();
          await reference
            .locator('img:visible')
            .evaluateAll((images) => Promise.all(images.map((image) => (image as HTMLImageElement).decode())));
          await captureScreen(reference, viewport, theme, referencePath);
          if (await reference.evaluate(() => Array.from(document.fonts).some((font) => font.status === 'error')))
            referenceFontFailures.add('見本のフォントの読み込みに失敗');
          if (referenceFontFailures.size)
            console.warn(
              `見本のフォントが代替表示の可能性があります（${label}）: ${[...referenceFontFailures].join('、')}`,
            );
        } finally {
          await Promise.all([appContext.close(), referenceContext.close()]);
        }
        const images = await composePair(
          comparison,
          appPath,
          referencePath,
          pairs,
          label,
          referenceFontFailures.size > 0,
        );
        results.push({
          theme,
          viewport,
          app: relative(directory, appPath),
          reference: relative(directory, referencePath),
          referenceFontFailures: [...referenceFontFailures],
          pairs: images.map((file) => relative(directory, file)),
        });
        console.log(`撮影済み ${theme} ${viewport.width}px`);
      }
    }
    await composeContactSheet(
      comparison,
      results.flatMap(({ pairs: files }) => files.map((file) => join(directory, file))),
      join(directory, 'contact-sheet.png'),
    );
    return results;
  } finally {
    await comparison.close();
  }
}

async function saveRound(staging: string, output: string) {
  const files = [
    'originals',
    'pairs',
    'motion',
    'contact-sheet.png',
    'design-rules.md',
    'exclusions.md',
    'capture.json',
  ];
  // capture.json は最後に置く。途中で移動が止まった周は採点資料として使わない。
  await rm(join(output, 'capture.json'), { force: true });
  // 旧版が周のディレクトリに置いた全文の写し（design.md）を消す。
  // 以前の周のディレクトリを使わなくなったら、この削除は外してよい。
  await rm(join(output, 'design.md'), { force: true });
  for (const name of files) {
    await rm(join(output, name), { recursive: true, force: true });
    await rename(join(staging, name), join(output, name));
  }
}

async function main() {
  const options = screenReviewOptions(process.argv.slice(2));
  const root = process.cwd();
  const fixedTime = reviewCaptureTime(new Date());
  const output = screenReviewOutput(root, options);
  const exclusions = options.exclusions && (await readFile(resolve(root, options.exclusions)));
  // 見出しが変わったときに空の規則で採点しないよう、ロックとブラウザの前に抜き出す。
  const designRules = extractDesignRules(await readFile(join(root, 'docs/design.md'), 'utf8'));
  await mkdir(output, { recursive: true });
  const lock = join(output, '.capture-in-progress');
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        `この周には撮影ロックがあります: ${lock}。異常終了したときの確認と復旧手順は docs/agent-workflows/screen-review.md を参照してください`,
        { cause: error },
      );
    throw error;
  }

  const abort = new AbortController();
  let browser: Browser | undefined;
  const interrupt = () => {
    abort.abort(new Error('撮影を中断しました'));
    void browser?.close().catch(() => undefined);
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const staging = join(lock, 'output');
  let scratch: string | undefined;
  let runtime: ReturnType<typeof localReviewRuntime> | undefined;
  let reference: Awaited<ReturnType<typeof serveReference>> | undefined;
  try {
    scratch = await mkdtemp(join(tmpdir(), 'screen-review-'));
    await mkdir(staging);
    runtime = localReviewRuntime(root, scratch, fixedTime, `screen-review-${randomUUID()}`, abort.signal);
    reference = await serveReference(root);
    browser = await launchChromium(runtime.options);
    await runtime.resetSeed();
    await runtime.start();
    const images = await captureToday(browser, runtime.origin, reference.origin, staging, fixedTime);
    await captureReviewMotion({
      browser,
      origin: runtime.origin,
      fixedTime,
      outputDir: staging,
      resetSeed: runtime.resetSeed,
      themes: CAPTURE_THEMES,
      signIn: addSeedSessionCookie,
      setTheme: setSeedTheme,
      composeFrames: frameComposer(browser),
    });
    await writeFile(join(staging, 'design-rules.md'), designRules.text);
    if (exclusions) await writeFile(join(staging, 'exclusions.md'), exclusions);
    else {
      await copyFile(join(output, 'exclusions.md'), join(staging, 'exclusions.md'), constants.COPYFILE_EXCL).catch(
        async (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          await writeFile(join(staging, 'exclusions.md'), '# 除外一覧\n\nなし。\n');
        },
      );
    }
    await writeFile(
      join(staging, 'capture.json'),
      JSON.stringify(
        {
          screen: options.screen,
          state: options.state,
          round: Number(options.round),
          fixedTime: fixedTime.toISOString(),
          browser: browser.version(),
          images,
          contactSheet: 'contact-sheet.png',
          motion: 'motion/results.json',
          designRules: 'design-rules.md',
          designRuleHeadings: designRules.headings,
          exclusions: 'exclusions.md',
        },
        null,
        2,
      ) + '\n',
    );
    abort.signal.throwIfAborted();
    await saveRound(staging, output);
    console.log(`撮影が完了しました。採点資料: ${output}`);
  } catch (error) {
    const failed = join(output, `failed-${randomUUID()}`);
    try {
      await rename(staging, failed);
      await writeFile(join(failed, 'failure.txt'), error instanceof Error ? error.message : String(error));
      console.error(`失敗した時点までの資料: ${failed}`);
    } catch (saveError) {
      console.error('撮影失敗時の資料を保存できません', saveError);
    }
    throw error;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    await Promise.allSettled([browser?.close(), runtime?.close()]);
    reference?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

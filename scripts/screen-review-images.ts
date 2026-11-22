import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Browser, Page } from '@playwright/test';

const GAP = 12;
const HEADER = 38;
const MAX_BAND_HEIGHT = 900;
const BAND_OVERLAP = 64;

async function png(path: string) {
  const file = await readFile(path);
  return {
    src: `data:image/png;base64,${file.toString('base64')}`,
    width: file.readUInt32BE(16),
    height: file.readUInt32BE(20),
  };
}

async function render(page: Page, html: string, width: number, height: number, path: string) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #e8ebef; color: #20242a; font: 15px sans-serif; }
    h2 { font-size: inherit; margin: 0; padding: 9px 12px; height: ${HEADER}px; }
    section { background: white; overflow: hidden; }
    img { display: block; }
  </style>${html}`);
  await page.screenshot({ path, scale: 'css' });
}

export function comparisonBands(height: number) {
  if (height <= MAX_BAND_HEIGHT) return [{ offset: 0, height }];
  const count = Math.ceil((height - BAND_OVERLAP) / (MAX_BAND_HEIGHT - BAND_OVERLAP));
  const bandHeight = Math.ceil((height + (count - 1) * BAND_OVERLAP) / count);
  return Array.from({ length: count }, (_, index) => {
    const offset = index * (bandHeight - BAND_OVERLAP);
    return { offset, height: Math.min(bandHeight, height - offset) };
  });
}

export async function composePair(
  page: Page,
  appPath: string,
  referencePath: string,
  directory: string,
  label: string,
) {
  const [app, reference] = await Promise.all([png(appPath), png(referencePath)]);
  const images = [app, reference];
  const bands = comparisonBands(Math.max(app.height, reference.height));
  const paths: string[] = [];
  for (const [index, band] of bands.entries()) {
    const columns = images.map((image, side) => {
      const caption = side === 0 ? 'App' : 'Reference';
      return `<section style="width:${image.width}px">
        <h2>${caption} · ${label} · ${index + 1}/${bands.length}</h2>
        <div style="height:${band.height}px; overflow:hidden">
          <img src="${image.src}" alt="" style="margin-top:-${band.offset}px">
        </div>
      </section>`;
    });
    const path = join(directory, `${label}${bands.length === 1 ? '' : `-${index + 1}`}.png`);
    await render(
      page,
      `<main style="display:flex; gap:${GAP}px">${columns.join('')}</main>`,
      app.width + reference.width + GAP,
      band.height + HEADER,
      path,
    );
    paths.push(path);
  }
  return paths;
}

export async function composeContactSheet(page: Page, paths: string[], output: string) {
  const cellWidth = 432;
  const cellHeight = 207;
  const columns = 3;
  const rows = Math.ceil(paths.length / columns);
  const images = await Promise.all(paths.map(png));
  const cells = images.map(
    (image, index) => `<section style="width:${cellWidth}px">
    <h2>${basename(paths[index]!, '.png')}</h2>
    <img src="${image.src}" alt="" style="width:${cellWidth}px;height:${cellHeight}px;object-fit:contain">
  </section>`,
  );
  await render(
    page,
    `<main style="display:grid; grid-template-columns:repeat(${columns}, ${cellWidth}px); gap:${GAP}px">${cells.join('')}</main>`,
    columns * (cellWidth + GAP) - GAP,
    rows * (cellHeight + HEADER + GAP) - GAP,
    output,
  );
}

export function frameComposer(browser: Browser) {
  return async (paths: string[], labels: string[], output: string) => {
    const frames = await Promise.all(paths.map(png));
    const width = frames.reduce((sum, frame) => sum + frame.width, 0) + GAP * (frames.length - 1);
    const height = Math.max(...frames.map((frame) => frame.height)) + HEADER;
    const columns = frames.map(
      (image, index) => `<section>
      <h2>${labels[index]}</h2><img src="${image.src}" alt="">
    </section>`,
    );
    const page = await browser.newPage();
    try {
      await render(page, `<main style="display:flex; gap:${GAP}px">${columns.join('')}</main>`, width, height, output);
    } finally {
      await page.close();
    }
  };
}

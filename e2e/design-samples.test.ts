import { openCatalog, routeDesignCatalog } from './design-samples.ts';
import { expect, test } from './fixtures.ts';

// 見本を開く e2e は、すべて design-samples.ts の関数でページの例外を集めて確かめる。関数が空振りすると全部が素通りするので、関数そのものを確かめる

test('見本を開く関数は、読み込み中に起きたページの例外を返す', async ({ page }) => {
  await routeDesignCatalog(page);
  // 先に登録した見本のルートより、後から足した差し替えが先に当たる
  await page.route('**/__design-catalog/index.html', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<h1>見本</h1><script>throw new Error("見本の例外")</script>',
    }),
  );
  const errors = await openCatalog(page);
  await expect(page.getByRole('heading', { level: 1, name: '見本', exact: true })).toBeVisible();
  await expect.poll(() => errors).toEqual(['見本の例外']);
});

test('見本を開く関数は、design/ の直下の HTML、CSS、JS だけを返し、ほかは 404 にする', async ({ page }) => {
  const errors = await openCatalog(page);
  const statuses = await page.evaluate(async () => {
    const paths = [
      '',
      'index.html',
      'tokens.css',
      'kit.js',
      'nope.html',
      'brand/master/symbol.webp',
      'brand',
      'constructor',
    ];
    return Promise.all(
      paths.map(async (path) => {
        const response = await fetch(`/__design-catalog/${path}`);
        return [path, response.status, response.headers.get('content-type')];
      }),
    );
  });
  expect(statuses).toEqual([
    ['', 200, 'text/html'],
    ['index.html', 200, 'text/html'],
    ['tokens.css', 200, 'text/css'],
    ['kit.js', 200, 'text/javascript'],
    ['nope.html', 404, null],
    ['brand/master/symbol.webp', 404, null],
    ['brand', 404, null],
    ['constructor', 404, null],
  ]);
  expect(errors).toEqual([]);
});

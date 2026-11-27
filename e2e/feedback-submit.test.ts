import { operationPath } from '../src/shared/operations/define.ts';
import { feedbackSubmit } from '../src/shared/operations/feedback.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';

test('ログインした人の送信は GitHub App が未設定の環境で 503 になる', async ({ context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const options = {
    headers: { Origin: origin },
    // multipart。入力の JSON は `input` の部分、画像はほかの部分（ここでは添えない）
    multipart: {
      input: {
        name: 'input',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ text: '画面についての感想です', route_id: '/', url: origin + '/' })),
      },
    },
  };

  const anonymous = await context.request.post(operationPath(feedbackSubmit), options);
  expect(anonymous.status()).toBe(401);
  expect(await anonymous.json()).toMatchObject({ error: { code: 'unauthenticated' } });

  await signIn(context, baseURL, 'admin');
  const authenticated = await context.request.post(operationPath(feedbackSubmit), options);
  expect(authenticated.status()).toBe(503);
  expect(await authenticated.json()).toMatchObject({ error: { code: 'unavailable' } });
});

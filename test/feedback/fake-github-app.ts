const INSTALLATION_ID = '12345';
const HOUR = 60 * 60 * 1000;
export const FEEDBACK_TOKEN_URL = `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`;
export const FEEDBACK_ISSUES_URL = 'https://api.github.com/repos/banmen-dev/app/issues';

async function generateFakePrivateKey(): Promise<string> {
  const keys = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const privateKey = (keys as CryptoKeyPair).privateKey;
  const keyBytes = new Uint8Array((await crypto.subtle.exportKey('pkcs8', privateKey)) as ArrayBuffer);
  const base64 = btoa(String.fromCharCode(...keyBytes));
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`;
}

let fakePrivateKey: string | undefined;

export async function fakeFeedbackGithubEnv(env: Env): Promise<Env> {
  fakePrivateKey ??= await generateFakePrivateKey();
  return {
    ...env,
    FEEDBACK_GITHUB_APP_ID: '67890',
    FEEDBACK_GITHUB_INSTALLATION_ID: INSTALLATION_ID,
    FEEDBACK_GITHUB_PRIVATE_KEY: fakePrivateKey,
  } as Env;
}

export function fakeFeedbackGithubResponse(request: Request): Response | undefined {
  if (request.method !== 'POST') return undefined;
  if (request.url === FEEDBACK_TOKEN_URL) {
    return Response.json(
      { token: 'fake-installation-token', expires_at: new Date(Date.now() + HOUR).toISOString() },
      { status: 201 },
    );
  }
  if (request.url === FEEDBACK_ISSUES_URL) return Response.json({ number: 42 }, { status: 201 });
  return undefined;
}

// 登録の関数が操作の前に行う検査のうち、DB を引かないもの
import type { Context } from 'hono';
import type { z } from 'zod';
import { ATTACHMENT_MAX_BYTES } from '../../shared/operations/attachment/index.ts';
import { ApiError } from '../errors.ts';
import type { AppEnv } from '../app-env.ts';
import type { BinaryBody } from './implement.ts';

const MAX_BODY_BYTES = 1024 * 1024;

// Origin が公開する URL と違う呼び出しを断る。すべての操作に掛ける。Origin の無い呼び出しも断る
// （ブラウザは POST に必ず Origin を付けるので、付いていないのは画面からの呼び出しではない）
export function requireOrigin(c: Context<AppEnv>): void {
  // 設定の誤りは握りつぶさず、new URL() の例外から 500 にする
  const allowed = new URL(c.env.PUBLIC_ORIGIN).origin;
  if (c.req.header('Origin') !== allowed) throw new ApiError(403, 'forbidden');
}

// img/video/リンクの GET は Origin が無い。同一オリジンの読み込みと直接の移動だけを通す。
// 古いブラウザや手元の HTTP クライアントのため、Fetch Metadata の無い呼び出しも認証へ進める。
export function requireDownloadOrigin(c: Context<AppEnv>): void {
  if (c.req.header('Origin') !== undefined) requireOrigin(c);
  const site = c.req.header('Sec-Fetch-Site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new ApiError(403, 'forbidden');
}

export function readDownloadInput<Schema extends z.ZodType>(c: Context<AppEnv>, schema: Schema): z.output<Schema> {
  const parsed = schema.safeParse({ id: c.req.param('id') });
  if (!parsed.success) throw new ApiError(400, 'invalid_input');
  return parsed.data;
}

// 本文を上限（バイト）まで読む。Content-Length が無い（chunked の）本文も、読んだ分を数えて上限で止める。
// 超えたら 413 の invalid_input。操作の定義のほか、画面のエラーの送信（src/server/client-errors.ts）が小さい上限で使う
export async function readBodyText(c: Context<AppEnv>, maxBytes: number = MAX_BODY_BYTES): Promise<string> {
  const declared = c.req.header('Content-Length');
  if (declared !== undefined && Number(declared) > maxBytes) throw new ApiError(413, 'invalid_input');
  const body = c.req.raw.body;
  if (body === null) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const chunks: string[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new ApiError(413, 'invalid_input');
    }
    try {
      chunks.push(decoder.decode(value, { stream: true }));
    } catch {
      await reader.cancel();
      throw new ApiError(400, 'invalid_input');
    }
  }
  try {
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch {
    throw new ApiError(400, 'invalid_input');
  }
}

// 入力は JSON の本文、binary の操作だけ X-Operation-Input。URL のクエリは読まない。
// Origin とセッションの検査の後に呼ぶ（未ログインの呼び出しに本文を読ませない）
export async function readInput<Schema extends z.ZodType>(
  c: Context<AppEnv>,
  schema: Schema,
  bodyType?: 'binary',
  maxBodyBytes?: number,
): Promise<z.output<Schema>> {
  let body: unknown;
  try {
    if (bodyType === 'binary') {
      const header = c.req.header('X-Operation-Input');
      if (header === undefined) throw new ApiError(400, 'invalid_input');
      body = JSON.parse(decodeURIComponent(header));
    } else {
      const contentType = c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') throw new ApiError(400, 'invalid_input');
      const text = await readBodyText(c, maxBodyBytes);
      if (maxBodyBytes !== undefined && maxBodyBytes > MAX_BODY_BYTES) checkLargeJsonStructure(text);
      body = JSON.parse(text);
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, 'invalid_input');
  }
  return parseInput(schema, body);
}

function parseInput<Schema extends z.ZodType>(schema: Schema, body: unknown): z.output<Schema> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  // 項目ごとの結果。message は zod の文で、入力の値は含めないが、入力のキーの名前は含みうる（未知のキーの指摘など）
  throw new ApiError(
    400,
    'invalid_input',
    parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      code: issue.code,
      message: issue.message,
    })),
  );
}

// multipart の部分の数の上限（input を含む）。上限の字数に収まる細かい部分を大量に並べて、解析を重くさせない
const MULTIPART_MAX_PARTS = 21;

// 本文をバイトで上限まで読む。申告の Content-Length が上限を超えれば読まずに 413、無い（chunked の）本文も読んだ分を数えて止める
async function readBodyBytes(c: Context<AppEnv>, maxBytes: number): Promise<Uint8Array> {
  const declared = c.req.header('Content-Length');
  if (declared !== undefined && Number(declared) > maxBytes) throw new ApiError(413, 'invalid_input');
  const body = c.req.raw.body;
  if (body === null) throw new ApiError(400, 'invalid_input');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    let step: ReadableStreamReadResult<Uint8Array>;
    try {
      step = await reader.read();
    } catch {
      throw new ApiError(400, 'invalid_input');
    }
    if (step.done) break;
    received += step.value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new ApiError(413, 'invalid_input');
    }
    chunks.push(step.value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// 文とファイルを1リクエストで受ける multipart/form-data。`input` の部分が入力の JSON（文字列の1つだけ）で、
// ほかの部分はすべてファイル。入力の部分が無い、重複、JSON でない、スキーマに合わない、ファイルでない部分、壊れた本文は 400 の invalid_input。
// 本文の全体が maxBodyBytes を超えれば 413 の invalid_input。Origin とセッションの検査の後に呼ぶ
export async function readMultipartInput<Schema extends z.ZodType>(
  c: Context<AppEnv>,
  schema: Schema,
  maxBodyBytes: number,
): Promise<{ input: z.output<Schema>; files: File[] }> {
  const contentType = c.req.header('Content-Type');
  if (contentType?.split(';')[0]?.trim().toLowerCase() !== 'multipart/form-data') {
    throw new ApiError(400, 'invalid_input');
  }
  const bytes = await readBodyBytes(c, maxBodyBytes);
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    throw new ApiError(400, 'invalid_input');
  }
  const entries = [...form.entries()];
  if (entries.length > MULTIPART_MAX_PARTS) throw new ApiError(400, 'invalid_input');
  const inputs = form.getAll('input');
  const text = inputs[0];
  if (inputs.length !== 1 || typeof text !== 'string') throw new ApiError(400, 'invalid_input');
  const files: File[] = [];
  for (const [key, value] of entries) {
    if (key === 'input') continue;
    if (typeof value === 'string') throw new ApiError(400, 'invalid_input');
    files.push(value);
  }
  let body: unknown;
  try {
    if (maxBodyBytes > MAX_BODY_BYTES) checkLargeJsonStructure(text);
    body = JSON.parse(text);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, 'invalid_input');
  }
  return { input: parseInput(schema, body), files };
}

// JSON.parseの前に構造の量を制限し、大量の空オブジェクト等を実体化させない。
// 大きな入力であっても、正規の入力は少数の長文ファイル。文字列内の記号は数えない。
function checkLargeJsonStructure(text: string) {
  let quoted = false;
  let escaped = false;
  let structures = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if ('{}[],:'.includes(char) && ++structures > 512) {
      throw new ApiError(400, 'invalid_input');
    }
  }
}

// ヘッダーの入力を検証した後、ワークスペースを確かめる前に呼ぶ。本文はここでは読まない。
// 上限は定義の maxBodyBytes（無ければ添付の ATTACHMENT_MAX_BYTES）。申告が上限を超えれば 413 の invalid_input
export function readBinaryBody(c: Context<AppEnv>, maxBodyBytes: number = ATTACHMENT_MAX_BYTES): BinaryBody {
  const declared = c.req.header('Content-Length');
  if (declared === undefined || !/^[0-9]+$/.test(declared)) throw new ApiError(400, 'invalid_input');
  const contentLength = Number(declared);
  if (contentLength === 0) throw new ApiError(400, 'invalid_input');
  if (contentLength > maxBodyBytes) throw new ApiError(413, 'invalid_input');
  const body = c.req.raw.body;
  if (body === null) throw new ApiError(400, 'invalid_input');
  return { body, contentLength, bucket: c.env.ATTACHMENTS };
}

// 本番の設定をコピーしない。プレビューの binding と URL はここだけで作る。
import { SEED_OPERATOR_LOGIN_ID } from '../seed/sessions.ts';
import {
  isPreviewSubdomain,
  LEGACY_PREVIEW_SUBDOMAIN,
  previewAlias,
  previewDatabaseName,
  previewOrigin,
  PREVIEW_WORKER_NAME,
} from '../src/shared/preview-cloudflare.ts';

export const PRODUCTION_DATABASE_ID = '7fc32f51-8771-4122-aa5d-3b69c07ff861';
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function previewConfig(
  number: string,
  database: { name: string; uuid: string },
  commitSha: string,
  root: string,
  subdomain = LEGACY_PREVIEW_SUBDOMAIN,
) {
  if (
    !/^[1-9][0-9]*$/.test(number) ||
    previewAlias(number).length > 63 ||
    !isPreviewSubdomain(subdomain) ||
    database.name !== previewDatabaseName(number) ||
    !UUID_PATTERN.test(database.uuid) ||
    database.uuid.toLowerCase() === PRODUCTION_DATABASE_ID ||
    !/^[0-9a-f]{40}$/i.test(commitSha)
  )
    throw new Error('プレビューの設定に使えない番号・D1・版です');
  return {
    name: PREVIEW_WORKER_NAME,
    main: `${root}/src/server/index.ts`,
    compatibility_date: '2026-10-01',
    send_metrics: false,
    assets: {
      directory: `${root}/build`,
      binding: 'ASSETS',
      not_found_handling: 'single-page-application',
      run_worker_first: ['/api', '/api/*'],
    },
    vars: {
      APP_VERSION: commitSha,
      PUBLIC_ORIGIN: previewOrigin(number, subdomain),
      OPERATOR_LOGIN_IDS: SEED_OPERATOR_LOGIN_ID,
      PREVIEW_WITHOUT_ATTACHMENTS: '1',
    },
    d1_databases: [
      { binding: 'DB', database_name: database.name, database_id: database.uuid, migrations_dir: `${root}/migrations` },
    ],
    workers_dev: true,
    preview_urls: true,
    // scheduled handler はあっても cron は登録しない。
    triggers: { crons: [] },
    observability: { enabled: true, logs: { invocation_logs: false } },
  };
}

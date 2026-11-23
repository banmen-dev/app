import { describe, expect, test } from 'vitest';
import { word, type DictionaryKey, type TemplateParams } from '../shared/vocabulary.ts';
import { historyActorName, historyEventText, type HistoryEntry } from './organization-history.ts';

const t = (key: DictionaryKey, params?: TemplateParams) => word(key, params);

describe('historyEventText', () => {
  test('個別の契約の標準の値を前後で示す', () => {
    expect(
      historyEventText(
        {
          kind: 'organization_plan_changed',
          from: {
            plan: 'custom',
            billing_interval: 'yearly',
            custom_member_limit: 80,
            custom_attachment_quota_bytes: 200 * 1024 ** 3,
          },
          to: {
            plan: 'custom',
            billing_interval: 'yearly',
            custom_member_limit: 90,
            custom_attachment_quota_bytes: 300 * 1024 ** 3,
          },
        },
        t,
      ),
    ).toBe('プランを個別・年払い（80 人・標準 200 GB）から個別・年払い（90 人・標準 300 GB）に変更しました');
  });

  test('種類ごとに、辞書の文を作る', () => {
    const cases: [HistoryEntry['event'], string][] = [
      [{ kind: 'organization_created', name: 'あおば開発' }, '組織「あおば開発」を作りました'],
      [{ kind: 'organization_created', name: null }, '組織を作りました'],
      [{ kind: 'organization_suspended', purge_on: '2026-11-25' }, '組織を停止しました（消す予定日 2026-11-25）'],
      [{ kind: 'organization_suspended', purge_on: null }, '組織を一時的に停止しました'],
      [{ kind: 'organization_resumed' }, '組織を再開しました'],
      [
        { kind: 'organization_suspension_changed', purge_on: '2026-11-25' },
        '停止の理由を解約に切り替えました（消す予定日 2026-11-25）',
      ],
      [{ kind: 'organization_suspension_changed', purge_on: null }, '停止の理由を一時的な停止に切り替えました'],
      [{ kind: 'organization_settings_changed' }, '組織の設定を変更しました'],
      [
        {
          kind: 'organization_quota_changed',
          member_limit: [15, 50],
          attachment_quota_bytes: [30 * 1024 ** 3, 100 * 1024 ** 3],
        },
        '人数の上限を 15\u00a0人から 50\u00a0人に、添付ファイルの上限を 30\u00a0GB から 100\u00a0GB に変えました',
      ],
      [
        { kind: 'organization_quota_changed', member_limit: [50, 1_000] },
        '人数の上限を 50\u00a0人から 1,000\u00a0人に変えました',
      ],
      [
        { kind: 'organization_quota_changed', attachment_quota_bytes: [512 * 1024 ** 2, 1024 ** 3] },
        '添付ファイルの上限を 512\u00a0MB から 1\u00a0GB に変えました',
      ],
      [
        {
          kind: 'organization_plan_changed',
          from: null,
          to: { plan: 'small', billing_interval: 'monthly' },
        },
        'プランをスモール・月払いにしました',
      ],
      [
        {
          kind: 'organization_plan_changed',
          from: { plan: 'business', billing_interval: 'monthly' },
          to: { plan: 'pro', billing_interval: 'yearly' },
        },
        'プランをビジネス・月払いからプロ・年払いに変更しました',
      ],
      [
        {
          kind: 'organization_storage_changed',
          from: { extra_10gb_units: 0, extra_50gb_units: 0, billing_interval: 'monthly' },
          to: { extra_10gb_units: 2, extra_50gb_units: 1, billing_interval: 'yearly' },
        },
        '追加容量を+10\u00a0GB 0\u00a0口・+50\u00a0GB 0\u00a0口（月払い）から+10\u00a0GB 2\u00a0口・+50\u00a0GB 1\u00a0口（年払い）に変更しました',
      ],
      [
        {
          kind: 'organization_storage_changed',
          from: { extra_10gb_units: 0, extra_50gb_units: 0, billing_interval: null },
          to: { extra_10gb_units: 1, extra_50gb_units: 0, billing_interval: 'monthly' },
        },
        '追加容量を+10\u00a0GB 0\u00a0口・+50\u00a0GB 0\u00a0口（未契約）から+10\u00a0GB 1\u00a0口・+50\u00a0GB 0\u00a0口（月払い）に変更しました',
      ],
      [
        { kind: 'organization_quota_changed', attachment_quota_bytes: [1024 ** 3, 1024 ** 3 + 1] },
        '添付ファイルの上限を 1\u00a0GB から 1.0000000009\u00a0GB に変えました',
      ],
      [{ kind: 'admin_designated', name: 'ミナト' }, 'ミナトを管理者に指名しました'],
      [{ kind: 'admin_designated', name: null }, 'メールアドレスで指定した人を管理者に指名しました'],
      [{ kind: 'admin_login_linked', name: 'ハルカ' }, 'ハルカがログインし、管理者の指名を受けました'],
      [{ kind: 'admin_designation_merged', name: 'ハルカ' }, '指名の URL で、ハルカを管理者にしました'],
      [{ kind: 'admin_designation_removed', name: 'ソラ' }, 'ソラへの管理者の指名を取り消しました'],
      [{ kind: 'admin_designation_removed', name: null }, 'メールアドレスで指定した人への管理者の指名を取り消しました'],
      [{ kind: 'admin_revoked', name: 'リン' }, 'リンの管理者を解除しました'],
      [{ kind: 'user_disabled', name: null }, '名前の分からない人を無効にしました'],
      [{ kind: 'user_enabled', name: 'カイ' }, 'カイを有効に戻しました'],
      [{ kind: 'workspace_created', workspace_name: '受託開発チーム' }, 'ワークスペース「受託開発チーム」を作りました'],
      [{ kind: 'workspace_created', workspace_name: null }, 'ワークスペースを作りました'],
      [{ kind: 'workspace_closed', workspace_name: '旧サイト保守' }, 'ワークスペース「旧サイト保守」を終了しました'],
      [{ kind: 'workspace_closed', workspace_name: null }, 'ワークスペースを終了しました'],
      [{ kind: 'workspace_reopened', workspace_name: null }, 'ワークスペースを再開しました'],
      [{ kind: 'workspace_reopened', workspace_name: '旧サイト保守' }, 'ワークスペース「旧サイト保守」を再開しました'],
      [{ kind: 'workspace_deleted', workspace_name: '旧サイト保守' }, 'ワークスペース「旧サイト保守」を削除しました'],
      [{ kind: 'workspace_deleted', workspace_name: null }, 'ワークスペースを削除しました'],
      [{ kind: 'delegatee_created', name: 'アサヒ' }, '依頼先「アサヒ」を追加しました'],
      [{ kind: 'delegatee_created', name: null }, '依頼先を追加しました'],
      [{ kind: 'delegatee_renamed', name: 'ナツメ' }, '依頼先の名前を「ナツメ」に変更しました'],
      [{ kind: 'delegatee_renamed', name: null }, '依頼先の名前を変更しました'],
      [{ kind: 'delegatee_deleted' }, '依頼先を削除しました'],
      [{ kind: 'other' }, '組織を変更しました'],
    ];
    for (const [event, text] of cases) {
      expect(historyEventText(event, t), event.kind).toBe(text);
    }
  });
});

describe('historyActorName', () => {
  test('人は名前、運用者は「運用者」、どちらでもなければ「自動の処理」', () => {
    expect(historyActorName({ kind: 'user', id: 'u1', name: 'ミナト' }, t)).toBe('ミナト');
    expect(historyActorName({ kind: 'user', id: 'u1', name: null }, t)).toBe('名前の分からない人');
    expect(historyActorName({ kind: 'operator' }, t)).toBe('運用者');
    expect(historyActorName({ kind: 'system' }, t)).toBe('自動の処理');
  });
});

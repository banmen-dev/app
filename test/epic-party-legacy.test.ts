// 討伐隊（epic_party_members）を外した後（#1434）も、表が残る間（#1438 で消す）は前に入った行が残る。
// 行がある状態で、エピックの画面、完了と取り消し、メンバーの離脱、ユーザーの無効化、まとめて削除が今までどおり通り、
// どの操作も行を読み書きしないことを確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { epicComplete, epicDelete, epicDetail, epicReopen } from '../src/shared/operations/epic/index.ts';
import { userDisable } from '../src/shared/operations/organization/index.ts';
import { membershipLeave } from '../src/shared/operations/workspace/index.ts';
import { createEpic, createEpicPartyMember, createStory } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget } from './operations/world.ts';

const app = createApp(implementedOperations);

describe('前に入った討伐隊の行があるエピック（#1434）', () => {
  test('画面、完了と取り消し、離脱、無効化、まとめて削除が通り、討伐隊の行はそのまま残る', async () => {
    const t = await createTarget();
    const epic = await createEpic(t.organization, t.workspace.id, t.admin.userId!);
    await createStory(t.organization, t.workspace.id, t.admin.userId!, {
      epic_id: epic.id,
      completed_at: '2026-10-20T00:00:00.000Z',
      completed_by: t.admin.userId!,
    });
    await createEpicPartyMember(t.organization, epic.id, t.member.userId!);
    await createEpicPartyMember(t.organization, epic.id, t.leader.userId!);
    const db = orgDb(env, t.organization.verified);
    const partyRows = () =>
      db.rows(
        db.statement((q) =>
          q.selectFrom('epic_party_members').select('user_id').where('epic_id', '=', epic.id).orderBy('user_id'),
        ),
      );
    const before = await partyRows();
    expect(before).toHaveLength(2);
    const ids = { workspace_id: t.workspace.id, epic_id: epic.id };

    const detail = await post(app, epicDetail, { slug: t.slug, token: t.member.token, body: ids });
    expect(detail.status).toBe(200);
    expect(await detail.json()).not.toHaveProperty('party');

    const completed = await post(app, epicComplete, { slug: t.slug, token: t.leader.token, body: ids });
    expect(completed.status).toBe(200);
    expect(Object.keys((await completed.json()) as object).sort()).toEqual(['completed_at', 'epic_id']);
    expect((await post(app, epicReopen, { slug: t.slug, token: t.leader.token, body: ids })).status).toBe(200);

    const left = await post(app, membershipLeave, {
      slug: t.slug,
      token: t.member.token,
      body: { workspace_id: t.workspace.id, user_id: t.member.userId! },
    });
    expect(left.status).toBe(200);
    const disabled = await post(app, userDisable, {
      slug: t.slug,
      token: t.admin.token,
      body: { user_id: t.leader.userId! },
    });
    expect(disabled.status).toBe(200);
    // 離脱と無効化は討伐隊の行を消さず、party_member の履歴も書かない
    expect(await partyRows()).toEqual(before);
    const partyLogs = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('change_logs')
          .select('id')
          .where('organization_id', '=', db.organizationId)
          .where('entity_type', '=', 'epic')
          .where('entity_id', '=', epic.id)
          .where('changes_json', 'like', '%party_member%'),
      ),
    );
    expect(partyLogs).toEqual([]);

    const deleted = await post(app, epicDelete, {
      slug: t.slug,
      token: t.admin.token,
      body: { ...ids, children: 'delete' },
    });
    expect(deleted.status).toBe(200);
    expect(await partyRows()).toEqual(before);
  });
});

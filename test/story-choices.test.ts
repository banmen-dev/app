// タスクの親に選べるストーリーの一覧（story-choices）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { describe, expect, test } from 'vitest';
import { storyChoices } from '../src/shared/operations/story/index.ts';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createEpic, createStory, createWorkspace } from './factories.ts';
import { post } from './operations/harness.ts';
import { createTarget } from './operations/world.ts';

const app = createApp(implementedOperations);

type Body = { stories: { id: string; title: string; epic: { id: string; title: string } | null }[] };

describe('story-choices', () => {
  test('完了していないストーリーを、エピックの順にその下のもの、続けて親のないものの順で、親のエピックつきで返す', async () => {
    const target = await createTarget();
    const { organization, workspace } = target;
    const by = target.admin.userId!;
    const later = await createEpic(organization, workspace.id, by, { title: '後のエピック', position: 'a2' });
    const first = await createEpic(organization, workspace.id, by, { title: '先のエピック', position: 'a1' });
    const finishedEpic = await createEpic(organization, workspace.id, by, {
      title: '済んだエピック',
      position: 'a3',
      completed_at: '2026-11-01T00:00:00.000Z',
    });
    const deletedEpic = await createEpic(organization, workspace.id, by, {
      title: '消したエピック',
      position: 'a0',
      deleted_at: '2026-11-01T00:00:00.000Z',
    });
    const root = await createStory(organization, workspace.id, by, { title: '親のないもの', position: 'a0' });
    const underLater = await createStory(organization, workspace.id, by, {
      title: '後の下',
      epic_id: later.id,
      position: 'a0',
    });
    const underFirst2 = await createStory(organization, workspace.id, by, {
      title: '先の下の2',
      epic_id: first.id,
      position: 'a2',
    });
    const underFirst1 = await createStory(organization, workspace.id, by, {
      title: '先の下の1',
      epic_id: first.id,
      position: 'a1',
    });
    const underFinished = await createStory(organization, workspace.id, by, {
      title: '済んだエピックの下',
      epic_id: finishedEpic.id,
      position: 'a0',
    });
    // 出さないもの: 完了したストーリー、削除したストーリー、削除したエピックの下、別のワークスペース
    await createStory(organization, workspace.id, by, { title: '完了', completed_at: '2026-11-01T00:00:00.000Z' });
    await createStory(organization, workspace.id, by, { title: '削除', deleted_at: '2026-11-01T00:00:00.000Z' });
    await createStory(organization, workspace.id, by, { title: '消したエピックの下', epic_id: deletedEpic.id });
    const other = await createWorkspace(organization, by);
    await createStory(organization, other.id, by, { title: '別のワークスペース' });
    // 別のワークスペースのエピックを指す行（ありえない形）は、親の題を漏らさず、行ごと出さない
    const otherEpic = await createEpic(organization, other.id, by, { title: '別のワークスペースのエピック' });
    await createStory(organization, workspace.id, by, { title: '別のエピックを指す', epic_id: otherEpic.id });

    const response = await post(app, storyChoices, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: workspace.id },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Body;
    expect(body.stories).toEqual([
      { id: underFirst1.id, title: '先の下の1', epic: { id: first.id, title: '先のエピック' } },
      { id: underFirst2.id, title: '先の下の2', epic: { id: first.id, title: '先のエピック' } },
      { id: underLater.id, title: '後の下', epic: { id: later.id, title: '後のエピック' } },
      { id: underFinished.id, title: '済んだエピックの下', epic: { id: finishedEpic.id, title: '済んだエピック' } },
      { id: root.id, title: '親のないもの', epic: null },
    ]);
  });

  test('閉じたワークスペースでも読める', async () => {
    const target = await createTarget();
    const closed = await createWorkspace(target.organization, target.admin.userId!, {
      closed_at: '2026-11-01T00:00:00.000Z',
    });
    const response = await post(app, storyChoices, {
      slug: target.slug,
      token: target.admin.token,
      body: { workspace_id: closed.id },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as Body).stories).toEqual([]);
  });
});

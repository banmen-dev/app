// 0049 より前のスキーマ（epics.reward_tier が NOT NULL）へ seed を流す検査用。seed は reward_tier を書かなくなったので、旧スキーマ向けに値を足す。
const EPIC_INSERT =
  /^INSERT INTO epics \(id, workspace_id, title, body_md, due_on, link_url, requester_user_id\b([^;]*?)\) VALUES\n([^;]*);/gm;

export function withEpicRewardTier(seed: string): string {
  const result = seed.replace(
    EPIC_INSERT,
    (_all, columnsRest: string, rows: string) =>
      `INSERT INTO epics (id, workspace_id, title, body_md, due_on, link_url, reward_tier, requester_user_id${columnsRest}) VALUES\n` +
      `${rows.replace(/, NULL, ('019a0000-0000-7000-8000-[0-9a-f]+', '019a0000-0000-7000-8000-[0-9a-f]+', 'a)/g, ", NULL, 'medium', $1")};`,
  );
  if (result === seed) throw new Error('seed の epics の INSERT が見つからない');
  return result;
}

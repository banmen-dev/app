// エピックのクリア報酬の段階（epics.reward_tier の CHECK と同じ並び）。報酬の仕組みは外した（#1434）が、列が残る間は
// 作るときに既定の段階（src/shared/epic.ts の EPIC_DEFAULT_REWARD_TIER）を書く。列は #1438 で消す。
// 経験値とレベルは外した（#1432）
export const epicRewardTiers = ['small', 'medium', 'large'] as const;
export type EpicRewardTier = (typeof epicRewardTiers)[number];

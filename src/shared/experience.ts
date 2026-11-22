// エピックのクリア報酬の段階（epics.reward_tier の CHECK と同じ並び）と、段階ごとの額。
// 経験値とレベルは外した（#1432）。クリアしても払わず、段階と額はクリア報酬の段階を選ぶダイアログにだけ出す。
// 段階と額は、エピックのクリア報酬を外すストーリー（#1434）で消す
export const epicRewardTiers = ['small', 'medium', 'large'] as const;
export type EpicRewardTier = (typeof epicRewardTiers)[number];

export const XP_EPIC_REWARD: Readonly<Record<EpicRewardTier, number>> = { small: 100, medium: 300, large: 600 };

import { expect, test } from 'vitest';
import { landingFor } from './landing.ts';

for (const count of [0, 1, 2]) {
  for (const invited of [false, true]) {
    for (const operator of [false, true]) {
      test(`${count}組織、招待${invited}、運用者${operator}の行き先`, () => {
        const account = {
          organizations: Array.from({ length: count }, (_, i) => ({ slug: `org-${i}` })),
          invitations: invited ? [{}] : [],
          operator,
        };
        expect(landingFor(account)).toEqual({ to: count === 0 && !invited && operator ? 'operator' : 'select' });
      });
    }
  }
}

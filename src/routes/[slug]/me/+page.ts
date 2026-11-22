import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../../lib/api.ts';
import { isUnauthenticated, loginUrl } from '../../../lib/login-redirect.ts';
import { me, tokenList } from '../../../shared/operations/session/index.ts';
import { invitationList } from '../../../shared/operations/workspace/index.ts';
import type { PageLoad } from './$types';

// マイプロフィールの画面が使う値。API トークンと届いた招待の節の値で、テーマの節は組織の枠が読んだ値（organization の操作の結果）を使う。
// 1日の基準、稼働期間、休み、月の基準の上書き、積載量の合計の節は #66 で足す。
// API トークンの一覧と発行の可否（tokens）、この組織の届いた招待（invitations）、再ログインの手段（me）を並べて読み、
// 読めなかったものだけを null にする（画面は、その節にだけ失敗を出す）。
// url は 401 のときだけ読む（読むと、移るたびにこの load が走り直る）
export const load: PageLoad = async ({ params, fetch, url }) => {
  const [tokens, invitations, myself] = await Promise.all([
    callOperation(tokenList, {}, { fetcher: fetch }),
    callOperation(invitationList, {}, { slug: params.slug, fetcher: fetch }),
    callOperation(me, {}, { fetcher: fetch }),
  ]);
  if (isUnauthenticated(tokens) || isUnauthenticated(invitations) || isUnauthenticated(myself)) {
    redirect(307, loginUrl(url));
  }
  return {
    tokens: tokens.ok ? tokens.data.tokens : null,
    canCreateToken: tokens.ok ? tokens.data.can_create : true,
    loginProvider: myself.ok ? myself.data.login_provider : null,
    invitations: invitations.ok ? invitations.data : null,
  };
};

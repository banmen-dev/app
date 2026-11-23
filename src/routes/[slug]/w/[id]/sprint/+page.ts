import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// 前の経路 /sprint（#1497 でボードの画面を /board に改めた）。古いリンクとブックマークのために、
// 同じワークスペースの /board へ移す。クエリ（?task=、?story= など）は引き継ぐ。
// 画面は SPA なので、+page.server.ts ではなく、この load で移す（load の中では url.hash を読めない）
export const load: PageLoad = ({ url }) => {
  redirect(308, url.pathname.replace(/\/sprint\/?$/, '/board') + url.search);
};

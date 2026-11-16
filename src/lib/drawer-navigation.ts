import { invalidate } from '$app/navigation';

// 引き出しを閉じる、前後へ移るときの URL の移動（goto）と、保存した後の読み直し（invalidate）の順をそろえる。
// SvelteKit は、移動の途中に始まった invalidate の読み直しを、移動が先に画面を替えると捨て（current が替わる）、
// 移動の終わりに読み直しの印（invalidated）も消す。保存の応答と閉じる操作が重なると、読み直しが失われ、
// 画面が保存の前の値のまま残り、読み直しの失敗も知らせない（#1331）。
// そこで、ワークスペースの枠が引き出しのために行う移動はここで覚え、読み直しは、その移動が終わってから始める。
// 移動より先に始まった読み直しは、移動の側が印を見て読み直すので、待たずに呼んでよい（ここで待つのは、移動の途中に呼ばれたものだけ）
let pending: Promise<unknown> | null = null;

// 引き出しの移動（goto の返り値）を、終わる（失敗、取りやめを含む）まで覚えておく。受け取った移動をそのまま返す
export function trackDrawerNavigation(navigation: Promise<void>): Promise<void> {
  pending = navigation;
  const settle = () => {
    if (pending === navigation) pending = null;
  };
  navigation.then(settle, settle);
  return navigation;
}

// 引き出しの移動が途中なら終わるのを待ってから、渡した印の load を読み直す。
// 待つ間に次の移動が始まったら、それも待つ
export async function invalidateAfterDrawerNavigation(...resources: string[]): Promise<void> {
  while (pending !== null) {
    await pending.catch(() => undefined);
  }
  await Promise.all(resources.map((resource) => invalidate(resource)));
}

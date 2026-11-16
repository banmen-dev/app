import { invalidate } from '$app/navigation';

// 画面の移動（goto、リンク、戻る／進む）と、保存した後の読み直し（invalidate）の順をそろえる。
// SvelteKit（3.1.0 で確かめた。client.js の _invalidate と navigate）は、移動の途中に始まった invalidate の読み直しを、
// 移動が先に画面を替えると捨て（current が替わる）、移動の終わりに読み直しの印（invalidated）も消す。
// 保存の応答と引き出しを閉じる操作が重なると、読み直しが失われ、画面が保存の前の値のまま残り、読み直しの失敗も知らせない（#1331）。
// そこで、ワークスペースの枠が beforeNavigate で移動を覚え（trackNavigation）、保存の後の読み直しは、その移動が終わってから始める。
// 移動より先に始まった読み直しは、移動の側が印を見て読み直すので、待たずに呼んでよい（ここで待つのは、移動の途中に呼ばれたものだけ）
let pending: Promise<unknown> | null = null;

// 移動が決着しないとき（SvelteKit が complete を解かない経路）に、読み直しを止めたままにしない上限
const SETTLE_LIMIT_MS = 10_000;

type TrackedNavigation = { complete: Promise<unknown>; willUnload: boolean };

// beforeNavigate に渡す。ページを離れる移動（willUnload）は、残るとブラウザが決めても complete が解けないので覚えない。
// 取りやめた移動（ほかの beforeNavigate が cancel した、後の移動に替わった）は、complete が reject で解ける
export function trackNavigation(navigation: TrackedNavigation): void {
  if (navigation.willUnload) return;
  const settled = navigation.complete.then(
    () => undefined,
    () => undefined,
  );
  pending = settled;
  void settled.then(() => {
    if (pending === settled) pending = null;
  });
}

// 移動が途中なら終わるのを待ってから、渡した印の load を読み直す。待つ間に次の移動が始まったら、それも待つ。
// 上限を過ぎたら待たずに読み直す
export async function invalidateAfterNavigation(...resources: string[]): Promise<void> {
  const deadline = Date.now() + SETTLE_LIMIT_MS;
  while (pending !== null) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([pending, new Promise<void>((resolve) => (timer = setTimeout(resolve, remaining)))]);
    clearTimeout(timer);
  }
  await Promise.all(resources.map((resource) => invalidate(resource)));
}

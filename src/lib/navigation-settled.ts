import { invalidate } from '$app/navigation';
import { navigating } from '$app/state';

// 画面の移動（goto、リンク、戻る／進む）と、保存した後の読み直し（invalidate）の順をそろえる。
// SvelteKit（3.1.0 と 3.4.0 で確かめた。client.js の _invalidate と navigate）は、移動の途中に始まった invalidate の読み直しを、
// 移動が先に画面を替えると捨て（current が替わる）、移動の終わりに読み直しの印（invalidated）も消す。
// 保存の応答と引き出しを閉じる操作が重なると、読み直しが失われ、画面が保存の前の値のまま残り、読み直しの失敗も知らせない（#1331）。
// そこで、保存の後の読み直しは、移動の途中（navigating が立っている間）なら、その移動が決着してから始める。
// navigating は、移動の途中に始まった次の移動でも立つ（beforeNavigate は呼ばれない）。
// 移動より先に始まった読み直しは、移動の側が印を見て読み直すので、待たずに呼んでよい。
// 移動の途中に応答が着く順は e2e で決まって作れない（閉じる移動は load を走らせず一瞬で終わる）ので、順は単体テストだけが確かめる。
// SvelteKit を上げたら、client.js の _invalidate と navigate、$app/state の navigating（complete、willUnload、決着の後に下ろす順）が
// ここの前提のままかを読み直す
const SETTLE_LIMIT_MS = 10_000;

// 移動が途中なら決着する（済む、取りやめ、後の移動に替わる）のを待ってから、渡した印の load を読み直す。
// 待つ間に次の移動が始まったら、それも待つ。ページを離れる移動は待たない。上限を過ぎたら待たずに読み直す。
// still が偽を返したら（待つ間に別の画面へ移ったなど）、読み直さない
export async function invalidateAfterNavigation(resources: string[], still: () => boolean = () => true): Promise<void> {
  const deadline = Date.now() + SETTLE_LIMIT_MS;
  let settled: Promise<unknown> | null = null;
  while (navigating.complete !== null && navigating.willUnload !== true) {
    const complete = navigating.complete;
    // 決着した後、SvelteKit が navigating を下ろすまでの間も同じ移動が見える。そのときは画面も印も替え終えている
    if (complete === settled) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      complete.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, remaining))),
    ]);
    clearTimeout(timer);
    settled = complete;
  }
  if (!still()) return;
  await Promise.all(resources.map((resource) => invalidate(resource)));
}

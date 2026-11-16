// 完了カードを左キーで戻した押下だけを、キーが離れるまで覚える。
// 戻った先でカードが作り直されても、押しっぱなしでさらに左の列へ流さない。
export class ReopenKeyGuard {
  #leftHeld = false;

  start(repeat: boolean | undefined): void {
    // メニューからはrepeatが渡らない。通常の未完了カードのキー反復には影響しない。
    if (repeat === false) this.#leftHeld = true;
  }

  suppress(repeat: boolean | undefined): boolean {
    return this.#leftHeld && repeat === true;
  }

  release(key: string): void {
    if (key === 'ArrowLeft') this.reset();
  }

  reset(): void {
    this.#leftHeld = false;
  }
}

// 保存基準の読み直しと、人が番号を入力した事実を分ける。
export class SprintNumberDraft {
  value = $state<number | null>(null);
  edited = $state(false);
  constructor(value: number) {
    this.value = value;
  }
  input(): void {
    this.edited = true;
  }
  receive(value: number): boolean {
    if (this.edited || this.value === value) return false;
    this.value = value;
    return true;
  }
  saved(value: number): void {
    this.value = value;
    this.edited = false;
  }
}

import { expandSprintName } from '../shared/sprint.ts';

// 作成ダイアログを開くたびに作り直す。人が一度入力したら、空に戻しても自動生成に戻さない。
export class SprintNameDraft {
  manual = $state<string | null>(null);
  constructor(
    readonly template: string | null,
    readonly number: number,
  ) {}
  value(startOn: string): string {
    return this.manual ?? expandSprintName(this.template, startOn, this.number) ?? '';
  }
  failed(startOn: string): boolean {
    return (
      this.manual === null && this.template !== null && expandSprintName(this.template, startOn, this.number) === null
    );
  }
}

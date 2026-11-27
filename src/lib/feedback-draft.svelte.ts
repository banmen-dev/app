import type { DictionaryKey } from '../shared/vocabulary.ts';

// 右下のフィードバックの書きかけの文と、送っている途中か、欄の下に出す理由。FeedbackLauncher は組織の枠、組織の選択、運用の画面に
// 別々に置くので、コンポーネントに持つと、それらの画面をまたいで移ったときに書いた文と送っている途中の印が消え、
// 送り終わりの知らせも、送り始めた（もう外れた）部品の閉じたダイアログを見て決めてしまう。
// タブの中で1つだけ持ち、どの画面の入口から開いても同じ文を出し、送り終わるまでは二重に送らない。読み直すと消える。
// openCount は開いているダイアログの数（同時に開くのは1つ）。sent は送れるたびに1つ増やし、開いているダイアログが閉じる合図にする。
// 書き込みは画面で打ち切らない（src/lib/api.ts）ので、応答が FEEDBACK_STALL_MS 来なければ stalled にして、送り直せるようにする
// （読み直さずに抜けられるようにするため。送り直すと同じ文が2件になりうることを欄の下に出す）。
// attempt は送り始めるたびに1つ増やし、送り直した後に届いた前の送信の応答を見分ける
export const FEEDBACK_STALL_MS = 30_000;

export const feedbackDraft = $state({
  text: '',
  sending: false,
  stalled: false,
  attempt: 0,
  error: null as DictionaryKey | null,
  openCount: 0,
  sent: 0,
});

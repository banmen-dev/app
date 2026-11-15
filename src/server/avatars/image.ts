// プロフィール画像のヘッダーを読む（Issue #1265）。PNG、JPEG、WebP の種類、縦横、動く画像かを返し、
// ほかの種類とヘッダーを読めないバイトは null。入れ物だけ。処理は後で書く
export type AvatarImage = {
  contentType: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  animated: boolean;
};

export function readAvatarImage(bytes: Uint8Array): AvatarImage | null {
  void bytes;
  throw new Error('未実装');
}

export type AppEnv = {
  Bindings: Env;
  // 操作のログと、エラーのログで揃える。cf-ray が無いリクエストには乱数を振る
  Variables: {
    requestId: string;
    binaryResponse?: true;
    // 定義の cacheControl（response: 'binary' の操作）。状態が 200 のときだけ Cache-Control に使う
    binaryCacheControl?: string;
  };
};

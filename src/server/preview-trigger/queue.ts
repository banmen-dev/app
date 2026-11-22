import type { PreviewRequest } from './webhook.ts';

export type PreviewQueueState = {
  pending?: PreviewRequest;
  active?: { request: PreviewRequest; id: string | null };
  last?: PreviewRequest;
};

export type PreviewQueueDeps = {
  read(): Promise<PreviewQueueState | undefined>;
  write(state: PreviewQueueState): Promise<void>;
  schedule(delayMs: number): Promise<void>;
  current(request: PreviewRequest): Promise<PreviewRequest | null>;
  start(request: PreviewRequest): Promise<string>;
  finished(buildId: string): Promise<boolean>;
};

// 同じ Issue の呼び出しは Durable Object 側で直列化する。
const BUILD_POLL_MS = 30_000;

export class PreviewBuildQueue {
  constructor(private readonly deps: PreviewQueueDeps) {}

  async enqueue(request: PreviewRequest): Promise<void> {
    const state = (await this.deps.read()) ?? {};
    const previous = state.pending;
    // 同じ head の通常イベントや遅れた再開イベントで、待機中の再開時刻を消さない。
    const keepPrevious =
      previous?.branch === request.branch &&
      previous.pr === request.pr &&
      previous.sha === request.sha &&
      previous.reopenedAt !== undefined &&
      (request.reopenedAt === undefined || previous.reopenedAt > request.reopenedAt);
    await this.deps.write({ ...state, pending: keepPrevious ? previous : request });
    await this.deps.schedule(0);
  }

  async run(): Promise<void> {
    const state = await this.deps.read();
    if (!state) return;

    if (state.active) {
      // POST が届いたか不明な状態では再送しない。遅れて始まるビルドと D1 の作り直しが重なるため。
      if (state.active.id === null) return;
      if (!(await this.deps.finished(state.active.id))) {
        await this.deps.schedule(BUILD_POLL_MS);
        return;
      }
      const finished = state.active.request;
      const previousReopen = state.last?.reopenedAt;
      // SHA が進んでも、以前の再開イベントを再送できるため、最後に処理した再開時刻を残す。
      state.last =
        previousReopen && (!finished.reopenedAt || previousReopen > finished.reopenedAt)
          ? { ...finished, reopenedAt: previousReopen }
          : finished;
      delete state.active;
      await this.deps.write(state);
    }

    if (!state.pending) return;
    const current = await this.deps.current(state.pending);
    delete state.pending;
    const last = state.last;
    const repeated =
      current &&
      last?.branch === current.branch &&
      last.sha === current.sha &&
      (!current.reopenedAt || (last.reopenedAt !== undefined && current.reopenedAt <= last.reopenedAt));
    if (!current || repeated) {
      await this.deps.write(state);
      return;
    }

    state.active = { request: current, id: null };
    await this.deps.write(state);
    state.active.id = await this.deps.start(current);
    await this.deps.write(state);
    await this.deps.schedule(BUILD_POLL_MS);
  }
}

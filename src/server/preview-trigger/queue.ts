import type { PreviewRequest } from './webhook.ts';

export class PreviewBuildRejected extends Error {}

export type PreviewRecovery =
  | { sha: string; attemptedAt: number; resolution: 'attach'; buildId: string }
  | { sha: string; attemptedAt: number; resolution: 'not-started' };

export type PreviewQueueState = {
  pending?: PreviewRequest;
  active?: { request: PreviewRequest; id: string | null; attemptedAt?: number };
  last?: PreviewRequest;
};

export type PreviewQueueDeps = {
  read(): Promise<PreviewQueueState | undefined>;
  write(state: PreviewQueueState): Promise<void>;
  schedule(delayMs: number): Promise<void>;
  current(request: PreviewRequest): Promise<PreviewRequest | null>;
  start(request: PreviewRequest): Promise<string>;
  finished(buildId: string): Promise<boolean>;
  verifyRecovery?(buildId: string, request: PreviewRequest, attemptedAt: number): Promise<boolean>;
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

  async recover(recovery: PreviewRecovery): Promise<boolean> {
    const state = await this.deps.read();
    const active = state?.active;
    if (
      !state ||
      active?.id !== null ||
      active.request.sha !== recovery.sha ||
      active.attemptedAt !== recovery.attemptedAt
    ) {
      return false;
    }

    if (recovery.resolution === 'attach') {
      if (!(await this.deps.verifyRecovery?.(recovery.buildId, active.request, recovery.attemptedAt))) return false;
      state.active = { ...active, id: recovery.buildId };
    } else {
      state.pending ??= active.request;
      delete state.active;
    }
    // 予約に失敗した場合は不明状態を保ち、同じ確認結果で復旧をやり直せるようにする。
    await this.deps.schedule(0);
    await this.deps.write(state);
    return true;
  }

  private async retryLookup<T>(lookup: () => Promise<T>): Promise<T> {
    try {
      return await lookup();
    } catch (error) {
      await this.deps.schedule(BUILD_POLL_MS);
      throw error;
    }
  }

  async run(): Promise<void> {
    const state = await this.deps.read();
    if (!state) return;

    const active = state.active;
    if (active) {
      // POST が届いたか不明な状態では再送しない。遅れて始まるビルドと D1 の作り直しが重なるため。
      const id = active.id;
      if (id === null) return;
      if (!(await this.retryLookup(() => this.deps.finished(id)))) {
        await this.deps.schedule(BUILD_POLL_MS);
        return;
      }
      const finished = active.request;
      const previousReopen = state.last?.reopenedAt;
      // SHA が進んでも、以前の再開イベントを再送できるため、最後に処理した再開時刻を残す。
      state.last =
        previousReopen && (!finished.reopenedAt || previousReopen > finished.reopenedAt)
          ? { ...finished, reopenedAt: previousReopen }
          : finished;
      delete state.active;
      await this.deps.write(state);
    }

    const pending = state.pending;
    if (!pending) return;
    const current = await this.retryLookup(() => this.deps.current(pending));
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

    state.active = { request: current, id: null, attemptedAt: Date.now() };
    await this.deps.write(state);
    try {
      state.active.id = await this.deps.start(current);
    } catch (error) {
      if (!(error instanceof PreviewBuildRejected)) throw error;
      // Cloudflare が起動を拒否した場合は、最新の head を照合し直してから再試行できる。
      state.pending = current;
      delete state.active;
      await this.deps.write(state);
      await this.deps.schedule(BUILD_POLL_MS);
      return;
    }
    await this.deps.write(state);
    await this.deps.schedule(BUILD_POLL_MS);
  }
}

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
  withStorage?<T>(operation: () => Promise<T>): Promise<T>;
  current(request: PreviewRequest): Promise<PreviewRequest | null>;
  start(request: PreviewRequest): Promise<string>;
  finished(buildId: string): Promise<boolean>;
  verifyRecovery?(buildId: string, request: PreviewRequest, attemptedAt: number): Promise<boolean>;
};

const BUILD_POLL_MS = 30_000;

function matchesRecovery(
  active: PreviewQueueState['active'],
  recovery: PreviewRecovery,
): active is NonNullable<PreviewQueueState['active']> {
  return active?.id === null && active.request.sha === recovery.sha && active.attemptedAt === recovery.attemptedAt;
}

export class PreviewBuildQueue {
  private running = false;
  private starting = false;
  private enqueueVersion = 0;
  // 同じ時刻と SHA でやり直しても、古い照会結果は別の試行に付けない。
  private recoveryVersion = 0;

  constructor(private readonly deps: PreviewQueueDeps) {}

  private withStorage<T>(operation: () => Promise<T>): Promise<T> {
    return this.deps.withStorage ? this.deps.withStorage(operation) : operation();
  }

  private schedule(delayMs: number): Promise<void> {
    return this.withStorage(() => this.deps.schedule(delayMs));
  }

  enqueue(request: PreviewRequest): Promise<void> {
    return this.withStorage(async () => {
      const state = (await this.deps.read()) ?? {};
      const previous = state.pending;
      const sameHead =
        previous?.issue === request.issue &&
        previous.branch === request.branch &&
        previous.pr === request.pr &&
        previous.sha === request.sha;
      // 同じ head の通常イベントや遅れた再開イベントで、待機中の再開時刻を消さない。
      const keepPrevious =
        sameHead &&
        previous.reopenedAt !== undefined &&
        (request.reopenedAt === undefined || previous.reopenedAt > request.reopenedAt);
      const pending = keepPrevious ? previous : request;
      await this.deps.write({ ...state, pending });
      if (!sameHead || previous.reopenedAt !== pending.reopenedAt) this.enqueueVersion += 1;
      await this.deps.schedule(0);
    });
  }

  status(): Promise<{ sha: string; attemptedAt: number } | null> {
    return this.withStorage(async () => {
      const active = (await this.deps.read())?.active;
      return !this.starting && active?.id === null && active.attemptedAt !== undefined
        ? { sha: active.request.sha, attemptedAt: active.attemptedAt }
        : null;
    });
  }

  async recover(recovery: PreviewRecovery): Promise<boolean> {
    if (recovery.resolution === 'attach') {
      const attempt = await this.withStorage(async () => {
        const active = (await this.deps.read())?.active;
        if (this.starting || !matchesRecovery(active, recovery)) return null;
        return { request: active.request, version: this.recoveryVersion };
      });
      if (!attempt || !(await this.deps.verifyRecovery?.(recovery.buildId, attempt.request, recovery.attemptedAt))) {
        return false;
      }
      return this.applyRecovery(recovery, attempt.version);
    }
    return this.applyRecovery(recovery);
  }

  private applyRecovery(recovery: PreviewRecovery, version?: number): Promise<boolean> {
    return this.withStorage(async () => {
      const state = await this.deps.read();
      const active = state?.active;
      if (
        !state ||
        this.starting ||
        (version !== undefined && version !== this.recoveryVersion) ||
        !matchesRecovery(active, recovery)
      ) {
        return false;
      }

      if (recovery.resolution === 'attach') {
        state.active = { ...active, id: recovery.buildId };
      } else {
        state.pending ??= active.request;
        delete state.active;
      }
      // 予約に失敗した場合は不明状態を保ち、同じ確認結果で復旧をやり直せるようにする。
      await this.deps.schedule(0);
      await this.deps.write(state);
      this.recoveryVersion += 1;
      return true;
    });
  }

  private async retryLookup<T>(lookup: () => Promise<T>): Promise<T> {
    try {
      return await lookup();
    } catch (error) {
      await this.schedule(BUILD_POLL_MS);
      throw error;
    }
  }

  async run(): Promise<void> {
    if (this.running) {
      // 別のアラームが予約を消費しても、待機中の処理を取り残さない。
      await this.schedule(BUILD_POLL_MS);
      return;
    }
    this.running = true;
    try {
      const active = (await this.withStorage(() => this.deps.read()))?.active;
      if (active && !(await this.finishActive(active.id))) return;
      await this.startPending();
    } finally {
      this.starting = false;
      this.running = false;
    }
  }

  private async finishActive(id: string | null): Promise<boolean> {
    // POST が届いたか不明な状態では再送しない。遅れて始まるビルドと D1 の作り直しが重なるため。
    if (id === null) return false;
    if (!(await this.retryLookup(() => this.deps.finished(id)))) {
      await this.schedule(BUILD_POLL_MS);
      return false;
    }

    return this.withStorage(async () => {
      const state = await this.deps.read();
      const active = state?.active;
      if (!state || active?.id !== id) return false;
      const finished = active.request;
      const previousReopen = state.last?.reopenedAt;
      // SHA が進んでも、以前の再開イベントを再送できるため、最後に処理した再開時刻を残す。
      state.last =
        previousReopen && (!finished.reopenedAt || previousReopen > finished.reopenedAt)
          ? { ...finished, reopenedAt: previousReopen }
          : finished;
      delete state.active;
      await this.deps.write(state);
      return true;
    });
  }

  private async startPending(): Promise<void> {
    const queued = await this.withStorage(async () => {
      const pending = (await this.deps.read())?.pending;
      return pending ? { request: pending, version: this.enqueueVersion } : null;
    });
    if (!queued) return;
    const current = await this.retryLookup(() => this.deps.current(queued.request));
    const attempt = await this.prepareStart(queued.version, current);
    if (!attempt) return;

    let id: string | undefined;
    try {
      id = await this.deps.start(attempt);
    } catch (error) {
      if (!(error instanceof PreviewBuildRejected)) throw error;
    }
    await this.withStorage(async () => {
      const state = await this.deps.read();
      const active = state?.active;
      if (!state || active?.id !== null) return;
      if (id === undefined) {
        // 拒否された要求は、通信中に次の要求が届いていない場合だけ戻す。
        state.pending ??= attempt;
        delete state.active;
      } else {
        active.id = id;
      }
      await this.deps.write(state);
      await this.deps.schedule(BUILD_POLL_MS);
    });
  }

  private prepareStart(enqueueVersion: number, current: PreviewRequest | null): Promise<PreviewRequest | null> {
    return this.withStorage(async () => {
      const state = await this.deps.read();
      if (!state?.pending || state.active) return null;
      // 同じ SHA に戻った場合も、その前に行った照合結果は使わない。
      if (enqueueVersion !== this.enqueueVersion) {
        await this.deps.schedule(0);
        return null;
      }

      delete state.pending;
      const last = state.last;
      const repeated =
        current &&
        last?.branch === current.branch &&
        last.sha === current.sha &&
        (!current.reopenedAt || (last.reopenedAt !== undefined && current.reopenedAt <= last.reopenedAt));
      if (!current || repeated) {
        await this.deps.write(state);
        return null;
      }

      state.active = { request: current, id: null, attemptedAt: Date.now() };
      await this.deps.write(state);
      this.starting = true;
      this.recoveryVersion += 1;
      return current;
    });
  }
}

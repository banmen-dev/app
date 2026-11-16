// 列の開閉は端末の見た目だけ。スプリントをまたいで同じワークスペースの列ごとに覚える。
export const sprintColumnCollapseKey = (workspaceId: string): string => `sg-sprint-columns-collapsed:${workspaceId}`;

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function parse(value: string | null): string[] | null {
  if (value === null) return [];
  try {
    const ids: unknown = JSON.parse(value);
    return Array.isArray(ids) && ids.every((id) => typeof id === 'string') ? [...new Set(ids)] : null;
  } catch {
    return null;
  }
}

export class SprintColumnCollapse {
  readonly key: string;
  ids = $state<string[]>([]);

  constructor(workspaceId: string) {
    this.key = sprintColumnCollapseKey(workspaceId);
    try {
      this.ids = parse(storage()?.getItem(this.key) ?? null) ?? [];
    } catch {
      /* 覚えられない端末では開く */
    }
  }

  isCollapsed(id: string): boolean {
    return this.ids.includes(id);
  }

  toggle(id: string): void {
    this.ids = this.isCollapsed(id) ? this.ids.filter((current) => current !== id) : [...this.ids, id];
    try {
      storage()?.setItem(this.key, JSON.stringify(this.ids));
    } catch {
      /* 保存できなくても今の画面では開閉する */
    }
  }

  handleStorage(event: { key: string | null; newValue: string | null; storageArea?: Storage | null }): void {
    if (event.storageArea !== undefined && event.storageArea !== storage()) return;
    if (event.key !== null && event.key !== this.key) return;
    const ids = parse(event.key === null ? null : event.newValue);
    if (ids !== null) this.ids = ids;
  }

  listen(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
    const handle = (event: StorageEvent) => this.handleStorage(event);
    target.addEventListener('storage', handle);
    return () => target.removeEventListener('storage', handle);
  }
}

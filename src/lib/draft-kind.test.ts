import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultDraftKind,
  draftKinds,
  draftKindKey,
  isDraftKind,
  readDraftKind,
  writeDraftKind,
} from './draft-kind.ts';

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

describe('draft-kind', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('初めて開いたときはタスク', () => {
    expect(defaultDraftKind).toBe('task');
    expect(readDraftKind()).toBe('task');
  });

  it('選んだ種類を覚えて、読み直しても返す', () => {
    writeDraftKind('epic');
    expect(readDraftKind()).toBe('epic');
    writeDraftKind('story');
    expect(readDraftKind()).toBe('story');
  });

  it('知らない値はタスクに戻す', () => {
    vi.stubGlobal('localStorage', fakeStorage({ [draftKindKey]: 'bug' }));
    expect(readDraftKind()).toBe('task');
  });

  it('localStorage に触れない端末でも、読むとタスク、書いても落ちない', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(readDraftKind()).toBe('task');
    expect(() => writeDraftKind('story')).not.toThrow();
  });

  it('並びはエピック、ストーリー、タスク', () => {
    expect([...draftKinds]).toEqual(['epic', 'story', 'task']);
  });

  it('種類かどうかを見分ける', () => {
    expect(isDraftKind('story')).toBe(true);
    expect(isDraftKind('sprint')).toBe(false);
    expect(isDraftKind(null)).toBe(false);
  });
});

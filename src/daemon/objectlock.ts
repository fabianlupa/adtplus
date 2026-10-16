import type { ObjectRef } from '@arc-mcp/adt-ls';

/**
 * Per-object read-write lock inside the daemon. An active-version read flips
 * the version adt-ls serves for the whole object, for the whole session
 * (`core/active-source.ts`); it holds the object exclusively, and every other
 * command on the object holds it shared, so none of them sees the flip.
 *
 * Shared holders may take several keys; exclusive holders take exactly one and
 * wait on nothing else while holding it, so there is no deadlock. A waiting
 * exclusive request blocks new shared ones, so it cannot starve.
 */

/**
 * `CLAS/OC`, `clas/oc` and `CLAS` name the same object; names are case-insensitive. A function
 * module or include belongs to a function group its ref doesn't name, and an active read of the
 * group flips its parts too, so every function group object of a system shares one key.
 */
export function objectKey(system: string, ref: Pick<ObjectRef, 'name' | 'objectType'>): string {
  const type = ref.objectType.split('/')[0]!.toUpperCase();
  return type === 'FUGR' ? `${system}:FUGR:*` : `${system}:${type}:${ref.name.toUpperCase()}`;
}

interface Waiter {
  exclusive: boolean;
  grant: () => void;
}

interface KeyState {
  readers: number;
  writer: boolean;
  queue: Waiter[];
}

export class ObjectLocks {
  private readonly keys = new Map<string, KeyState>();

  private state(key: string): KeyState {
    let s = this.keys.get(key);
    if (!s) {
      s = { readers: 0, writer: false, queue: [] };
      this.keys.set(key, s);
    }
    return s;
  }

  private acquire(key: string, exclusive: boolean): Promise<void> {
    const s = this.state(key);
    const free = exclusive ? !s.writer && s.readers === 0 : !s.writer && s.queue.length === 0;
    if (free) {
      if (exclusive) s.writer = true;
      else s.readers += 1;
      return Promise.resolve();
    }
    return new Promise((grant) => s.queue.push({ exclusive, grant }));
  }

  private release(key: string, exclusive: boolean): void {
    const s = this.state(key);
    if (exclusive) s.writer = false;
    else s.readers -= 1;
    // Wake the head of the queue: one exclusive waiter, or every shared one up to the next exclusive.
    while (s.queue.length > 0 && !s.writer) {
      const next = s.queue[0]!;
      if (next.exclusive) {
        if (s.readers > 0) break;
        s.queue.shift();
        s.writer = true;
        next.grant();
        break;
      }
      s.queue.shift();
      s.readers += 1;
      next.grant();
    }
    if (!s.writer && s.readers === 0 && s.queue.length === 0) this.keys.delete(key);
  }

  async shared<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const unique = [...new Set(keys)].sort();
    const held: string[] = [];
    try {
      for (const key of unique) {
        await this.acquire(key, false);
        held.push(key);
      }
      return await fn();
    } finally {
      for (const key of held) this.release(key, false);
    }
  }

  async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(key, true);
    try {
      return await fn();
    } finally {
      this.release(key, true);
    }
  }
}

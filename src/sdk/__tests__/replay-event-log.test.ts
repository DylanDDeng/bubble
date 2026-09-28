import { describe, expect, it } from 'vitest';
import { ReplayEventLog } from '../replay-event-log.js';

async function collect<T>(stream: AsyncIterable<T>) {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

describe('SDK replay retention', () => {
  it('preserves unlimited public replay by default', async () => {
    const log = new ReplayEventLog<number>();
    for (let i = 0; i < 10000; i++) log.append(i);
    log.close();
    expect(await collect(log.iterate())).toHaveLength(10000);
    expect(log.retainedCount).toBe(10000);
  });

  it('bounds consumed history while keeping monotonic cursors', async () => {
    const log = new ReplayEventLog<number>(256);
    for (let i = 0; i < 12000; i++) log.append(i);
    expect(log.length).toBe(12000);
    expect(log.retainedCount).toBe(256);
    log.close();
    expect(await collect(log.iterate({ from: 11998 }))).toEqual([11998, 11999]);
    await expect(collect(log.iterate({ from: 0 }))).rejects.toThrow('cursor expired');
  });

  it('protects subscribers before first next and while a slow reader lags', async () => {
    const log = new ReplayEventLog<number>(2);
    const slow = log.iterate();
    const fast = log.iterate();
    for (let i = 0; i < 1000; i++) log.append(i);
    log.close();
    expect(await collect(fast)).toHaveLength(1000);
    expect(log.retainedCount).toBe(1000);
    expect(await collect(slow)).toEqual(Array.from({ length: 1000 }, (_, i) => i));
    expect(log.retainedCount).toBe(2);
  });

  it('releases a never-started subscription on close or return', async () => {
    for (const abort of [true, false]) {
      const log = new ReplayEventLog<number>(2);
      const controller = new AbortController();
      const reader = log.iterate({ signal: controller.signal });
      for (let i = 0; i < 100; i++) log.append(i);
      if (abort) controller.abort(); else await reader.return(undefined);
      expect(log.retainedCount).toBe(2);
    }
  });

  it('return interrupts an idle reader and close propagates failure', async () => {
    const log = new ReplayEventLog<number>(2);
    const reader = log.iterate();
    const pending = reader.next();
    await reader.return(undefined);
    expect((await pending).done).toBe(true);
    log.close(new Error('failed'));
    await expect(collect(log.iterate())).rejects.toThrow('failed');
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJobRunner, serveJobs } from '../src/platform/WorkerJobRunner';
import type { ThreadingScope } from '../src/platform/threading';

/**
 * PlatformLayer 的工作线程块（实现路径文档 §2 的第 2 项）。
 *
 * 用例把 `serveJobs`（worker 那一侧）和 `createJobRunner`（主线程那一侧）接在
 * 一个假 worker 上对跑——两侧的报文格式是私有的，只有让它们互相说话才测得到。
 */

/** 有 Worker 构造器的宿主。Node 里没有这个全局量，所以要喂一个假 scope。 */
const WORKER_SCOPE = { Worker: class {} } as unknown as ThreadingScope;
const NO_WORKER_SCOPE = {} as ThreadingScope;

type Listener = (event: { data?: unknown }) => void;

/** 把 `serveJobs` 装进来的假 worker：同进程，但报文来回都走真实那条路径。 */
class FakeWorker {
  private readonly hostListeners = new Map<string, Listener[]>();
  private readonly workerListeners = new Map<string, Listener[]>();
  public terminated = false;
  public readonly transferred: unknown[][] = [];

  public constructor(handle: (request: unknown) => { result: unknown; transfer?: readonly ArrayBufferLike[] }) {
    serveJobs(handle as never, {
      addEventListener: (type: 'message', listener: Listener) => {
        this.workerListeners.set(type, [...(this.workerListeners.get(type) ?? []), listener]);
      },
      postMessage: (message: unknown, transfer?: unknown[]) => {
        this.transferred.push(transfer ?? []);
        for (const listener of this.hostListeners.get('message') ?? []) listener({ data: message });
      },
    } as never);
  }

  public addEventListener(type: string, listener: Listener): void {
    this.hostListeners.set(type, [...(this.hostListeners.get(type) ?? []), listener]);
  }

  public postMessage(message: unknown): void {
    for (const listener of this.workerListeners.get('message') ?? []) listener({ data: message });
  }

  public terminate(): void {
    this.terminated = true;
  }

  /** 模拟 worker 崩掉。 */
  public fail(reason: string): void {
    for (const listener of this.hostListeners.get('error') ?? []) listener({ data: reason });
  }
}

test('拿不到 Worker 时就地跑同一份实现，而且仍然是 Promise', async () => {
  let created = false;
  const runner = createJobRunner<number, number>({
    createWorker: () => { created = true; return undefined as never; },
    runInline: (value) => value * 2,
    scope: NO_WORKER_SCOPE,
  });
  assert.equal(runner.kind, 'inline');
  assert.equal(created, false, '没有 Worker 时不该去构造它');
  assert.equal(await runner.run(21), 42);
  runner.dispose();
});

test('构造 worker 抛异常也降级到就地执行，而不是让调用方拿不到结果', async () => {
  const runner = createJobRunner<number, number>({
    createWorker: () => { throw new Error('blocked by CSP'); },
    runInline: (value) => value + 1,
    scope: WORKER_SCOPE,
  });
  assert.equal(runner.kind, 'inline');
  assert.equal(await runner.run(1), 2);
  runner.dispose();
});

test('走 worker 时结果按 id 配回请求，并发也不会串线', async () => {
  const worker = new FakeWorker((request) => ({ result: (request as number) * 10 }));
  const runner = createJobRunner<number, number>({
    createWorker: () => worker as never,
    runInline: () => { throw new Error('不该走到就地实现'); },
    scope: WORKER_SCOPE,
  });
  assert.equal(runner.kind, 'worker');
  assert.deepEqual(await Promise.all([runner.run(1), runner.run(2), runner.run(3)]), [10, 20, 30]);
  runner.dispose();
  assert.equal(worker.terminated, true);
});

test('worker 里抛出的异常变成这一次请求的 reject，不影响后面的请求', async () => {
  const worker = new FakeWorker((request) => {
    if (request === 0) throw new Error('bad chunk');
    return { result: request };
  });
  const runner = createJobRunner<number, number>({
    createWorker: () => worker as never,
    runInline: () => { throw new Error('不该走到就地实现'); },
    scope: WORKER_SCOPE,
  });
  await assert.rejects(() => runner.run(0), /bad chunk/);
  assert.equal(await runner.run(7), 7);
  runner.dispose();
});

test('worker 崩掉：在途的全部拒掉，之后的请求就地跑', async () => {
  const worker = new FakeWorker(() => ({ result: 0 }));
  // 让这次请求卡住不回应答，好让它成为「在途」的那一个。
  let sent = 0;
  worker.postMessage = () => { sent += 1; };
  const runner = createJobRunner<number, number>({
    createWorker: () => worker as never,
    runInline: (value) => value * 3,
    scope: WORKER_SCOPE,
  });
  const inFlight = runner.run(5);
  worker.fail('OOM');
  await assert.rejects(() => inFlight, /重新提交/);
  // 降级之后调用方不需要改代码，同一个 run 继续可用。
  assert.equal(await runner.run(5), 15);
  assert.equal(sent, 1, '崩过之后不该再往那个 worker 发东西');
  runner.dispose();
});

test('大件按转移交出去，不是复制一份', async () => {
  const worker = new FakeWorker(() => {
    const payload = new Float32Array([1, 2, 3]);
    return { result: payload, transfer: [payload.buffer] };
  });
  const runner = createJobRunner<number, Float32Array>({
    createWorker: () => worker as never,
    runInline: () => new Float32Array(),
    scope: WORKER_SCOPE,
  });
  const result = await runner.run(1);
  assert.equal(result.length, 3);
  assert.equal(worker.transferred[0]?.length, 1, 'worker 应当把缓冲区转移出来');
  runner.dispose();
});

test('释放之后的请求直接 reject，不会静静地挂住', async () => {
  const worker = new FakeWorker(() => ({ result: 1 }));
  const runner = createJobRunner<number, number>({
    createWorker: () => worker as never,
    runInline: () => 1,
    scope: WORKER_SCOPE,
  });
  runner.dispose();
  await assert.rejects(() => runner.run(1), /已释放/);
});

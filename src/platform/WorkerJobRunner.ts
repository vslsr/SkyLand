import { detectThreadingCapabilities, type ThreadingScope } from './threading';

/**
 * PlatformLayer · 工作线程与请求／响应通道（引擎迁移路线图 §7 / 第 2 步）。
 *
 * 这是 PlatformLayer 的第二块。第一块（`threading.ts`）回答「这台机器能不能开线程」，
 * 这一块回答「开了之后怎么把一件事交出去」。
 *
 * 刻意做成**一次请求一次响应的纯函数调用**，不是通用的消息总线：
 * 现在要搬过去的活（地形碰撞网格）本来就是纯函数，而通用总线会诱使调用方
 * 把状态也搬过去——那是第 2 步真正难的部分，不该被一个工具类顺手带进来。
 *
 * **拿不到 worker 时就地跑同一份实现**，而且保持同样的 `Promise` 形状：
 * 调用方只有一条代码路径。这和 `loadChunkGenerator` 里「WASM 加载失败就降级到 JS」
 * 是同一个取向——一个 3 KB 的文件加载不出来，不该让玩家进不去游戏。
 */

/** worker 与主线程之间那两条报文。`id` 用来把响应配回请求。 */
interface JobRequestMessage<Request> {
  readonly id: number;
  readonly payload: Request;
}

interface JobResponseMessage<Response> {
  readonly id: number;
  readonly result?: Response;
  readonly error?: string;
}

export interface JobRunner<Request, Response> {
  /** 这次实际走的是哪条路。降级是静默的，所以要能问出来。 */
  readonly kind: 'worker' | 'inline';
  run(request: Request, transfer?: readonly Transferable[]): Promise<Response>;
  dispose(): void;
}

export interface JobRunnerOptions<Request, Response> {
  /**
   * 造 worker。**必须由调用方给**：打包器要在调用处看见字面量
   * `new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })`
   * 才能把 worker 一起打进产物，这个文件里写不出那个字面量。
   */
  createWorker(): Worker;
  /** 同一份实现的就地版本。降级、以及 Node 下的测试都走它。 */
  runInline(request: Request): Response;
  scope?: ThreadingScope;
}

/**
 * worker 侧的样板：把一个纯函数接到上面那两条报文上。
 * worker 入口文件里只需要一行 `serveJobs(handler)`。
 */
export function serveJobs<Request, Response>(
  handle: (request: Request) => { result: Response; transfer?: readonly Transferable[] },
  scope: {
    addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
    postMessage(message: unknown, transfer?: Transferable[]): void;
  } = self as never,
): void {
  scope.addEventListener('message', (event: MessageEvent) => {
    const request = event.data as JobRequestMessage<Request>;
    try {
      const { result, transfer } = handle(request.payload);
      scope.postMessage(
        { id: request.id, result } satisfies JobResponseMessage<Response>,
        transfer ? [...transfer] : [],
      );
    } catch (error) {
      scope.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies JobResponseMessage<Response>);
    }
  });
}

export function createJobRunner<Request, Response>(
  options: JobRunnerOptions<Request, Response>,
): JobRunner<Request, Response> {
  const inline = (): JobRunner<Request, Response> => ({
    kind: 'inline',
    run: (request) => {
      // 同步跑，但保持 Promise 形状：调用方不该为「有没有 worker」分两条路径。
      try {
        return Promise.resolve(options.runInline(request));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    dispose: () => undefined,
  });

  if (!detectThreadingCapabilities(options.scope).workers) return inline();

  let worker: Worker;
  try {
    worker = options.createWorker();
  } catch (error) {
    console.warn('[platform] 工作线程创建失败，已就地执行', error);
    return inline();
  }

  const settlers = new Map<number, {
    resolve: (value: Response) => void;
    reject: (reason: Error) => void;
  }>();
  let nextId = 1;
  let fallback: JobRunner<Request, Response> | undefined;
  let disposed = false;

  /**
   * worker 死了：在途的全部拒掉，之后的请求就地跑。
   *
   * 不重建 worker——同一个原因多半会再死一次，而那会把「偶尔卡一下」变成
   * 「每次都卡一下再重来」。降级一次、把原因打出来，比反复重试诚实。
   */
  const degrade = (reason: unknown): void => {
    if (fallback || disposed) return;
    console.warn('[platform] 工作线程异常，后续任务已就地执行', reason);
    fallback = inline();
    const pending = [...settlers.values()];
    settlers.clear();
    for (const settler of pending) {
      settler.reject(new Error('工作线程已退出，这一批任务需要重新提交'));
    }
  };

  worker.addEventListener('message', (event: MessageEvent) => {
    const response = event.data as JobResponseMessage<Response>;
    const settler = settlers.get(response.id);
    if (!settler) return;
    settlers.delete(response.id);
    if (response.error !== undefined) settler.reject(new Error(response.error));
    else settler.resolve(response.result as Response);
  });
  worker.addEventListener('error', degrade);
  worker.addEventListener('messageerror', degrade);

  return {
    kind: 'worker',
    run(request, transfer) {
      if (fallback) return fallback.run(request);
      if (disposed) return Promise.reject(new Error('JobRunner 已释放'));
      const id = nextId;
      nextId += 1;
      return new Promise<Response>((resolve, reject) => {
        settlers.set(id, { resolve, reject });
        try {
          worker.postMessage(
            { id, payload: request } satisfies JobRequestMessage<Request>,
            transfer ? [...transfer] : [],
          );
        } catch (error) {
          settlers.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    dispose() {
      disposed = true;
      const pending = [...settlers.values()];
      settlers.clear();
      for (const settler of pending) settler.reject(new Error('JobRunner 已释放'));
      worker.terminate();
    },
  };
}

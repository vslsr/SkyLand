import type { NormalizedGrassBendImpulse } from './GrassInteraction';
import {
  decodeGrassTrailPath,
  encodeGrassTrailPath,
  GrassTrailPath,
  type GrassTrailPathOptions,
} from './GrassTrailPath';

/**
 * 同时被记录的路径条数上界。
 *
 * 大世界里可以有任意多个会压草的东西，但一张 32 米的弯曲窗口里塞不下也看不清
 * 那么多条足迹。超出这个数时按「离焦点最远」淘汰，所以 CPU、显存和每帧的
 * 盖章绘制量都与世界里的玩家总数无关，只与这个常数有关。
 */
export const GRASS_TRAIL_MAX_SOURCES = 8;

/** 没有指定来源的输入（鼠标、调试）共用这一条路径。 */
export const DEFAULT_GRASS_TRAIL_SOURCE = 'default';

export interface GrassTrailRecorderOptions extends GrassTrailPathOptions {
  maxSources?: number;
}

interface TrackedTrail {
  path: GrassTrailPath;
  /** 最近一次收到输入之后经过的秒数，用来淘汰已经走远的来源。 */
  idleSeconds: number;
}

/**
 * 按来源把踩踏冲量攒成有限长度的路径。
 *
 * 每个会压草的东西（本地玩家、每个远端玩家、鼠标）各自一条路径：合并成一条的话
 * 两名玩家分开走会被连成一条穿过他们之间的假足迹。
 */
export class GrassTrailRecorder {
  public readonly maxSources: number;

  private readonly trails = new Map<string, TrackedTrail>();
  private readonly pathOptions: GrassTrailPathOptions;
  private focusX = 0;
  private focusZ = 0;

  public constructor(options: GrassTrailRecorderOptions = {}) {
    this.maxSources = Math.max(1, Math.floor(
      positiveFiniteOr(options.maxSources, GRASS_TRAIL_MAX_SOURCES),
    ));
    this.pathOptions = {
      capacity: options.capacity,
      minimumSpacing: options.minimumSpacing,
      recoverySeconds: options.recoverySeconds,
    };
  }

  public get sourceCount(): number {
    return this.trails.size;
  }

  /** 淘汰参考点。窗口跟着谁走，路径就优先保留谁附近的。 */
  public setFocus(focusX: number, focusZ: number): void {
    if (!Number.isFinite(focusX) || !Number.isFinite(focusZ)) return;
    this.focusX = focusX;
    this.focusZ = focusZ;
  }

  public ingest(impulses: readonly NormalizedGrassBendImpulse[]): void {
    for (const impulse of impulses) {
      const trail = this.acquire(impulse.sourceId);
      trail.idleSeconds = 0;
      trail.path.push(
        impulse.positionX,
        impulse.positionZ,
        impulse.radius,
        impulse.strength,
      );
    }
  }

  /** 推进所有路径的回弹，并回收已经空掉且不再有输入的来源。 */
  public advance(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    for (const [sourceId, trail] of this.trails) {
      trail.path.advance(deltaSeconds);
      trail.idleSeconds += deltaSeconds;
      if (trail.path.isEmpty && trail.idleSeconds > 0) this.trails.delete(sourceId);
    }
  }

  public forEachPath(visit: (path: GrassTrailPath, sourceId: string) => void): void {
    for (const [sourceId, trail] of this.trails) {
      if (trail.path.isEmpty) continue;
      visit(trail.path, sourceId);
    }
  }

  public getPath(sourceId: string): GrassTrailPath | undefined {
    return this.trails.get(sourceId)?.path;
  }

  /** 网络出口：把一条路径编码成定长上界的字节。 */
  public encodePath(sourceId: string): Uint8Array | undefined {
    const trail = this.trails.get(sourceId);
    return trail ? encodeGrassTrailPath(trail.path) : undefined;
  }

  /**
   * 网络入口：用收到的字节整条替换某个来源的路径。
   *
   * 整条替换而不是增量追加，是因为快照本身可能丢、可能乱序；一条定长路径
   * 每次都自带完整状态，晚到的一帧最多让足迹回退一点，不会累出鬼影。
   */
  public decodePath(sourceId: string, bytes: Uint8Array): GrassTrailPath {
    const trail = this.acquire(sourceId);
    trail.idleSeconds = 0;
    decodeGrassTrailPath(bytes, trail.path);
    return trail.path;
  }

  public clear(): void {
    this.trails.clear();
  }

  private acquire(sourceId: string): TrackedTrail {
    const existing = this.trails.get(sourceId);
    if (existing) return existing;
    if (this.trails.size >= this.maxSources) this.evictFarthest();
    const created: TrackedTrail = {
      path: new GrassTrailPath(this.pathOptions),
      idleSeconds: 0,
    };
    this.trails.set(sourceId, created);
    return created;
  }

  /** 空路径最先走；都非空时丢掉离焦点最远的那条。 */
  private evictFarthest(): void {
    let victimId: string | undefined;
    let victimScore = -Infinity;
    for (const [sourceId, trail] of this.trails) {
      const head = trail.path.head;
      const score = head
        ? Math.hypot(head.x - this.focusX, head.z - this.focusZ)
        : Infinity;
      if (score > victimScore) {
        victimScore = score;
        victimId = sourceId;
      }
    }
    if (victimId !== undefined) this.trails.delete(victimId);
  }
}

function positiveFiniteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? value as number : fallback;
}

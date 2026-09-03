/**
 * 把机位与 transform **成对**读入渲染世界（引擎迁移路线图 第 3 步的补丁）。
 *
 * 两段字节各自翻面。主线程一帧里先翻 transform、再翻机位，机位那一面带着它配的
 * transform 帧号（`RenderCameraBuffer.publish(pairedTransformFrameId)`）。渲染线程
 * 读的时候核对这个号：对上了，画出来的相机与世界就是同一帧；对不上，说明主线程
 * 正卡在两次翻面之间——机位那一面几微秒到几毫秒内就到，等它一下再读一次。
 *
 * 只有两种对不上：
 *
 * - 机位配的号 **小于** 刚兑现的 transform 帧号：transform 已经翻到下一帧，机位还没。
 *   等机位翻面，然后**两样都重读**（transform 也可能又翻了）。
 * - 机位配的号 **大于**：只在主线程翻面顺序被写反时出现。重读 transform 即可。
 *
 * 重试有上限：主线程真的卡在两次翻面之间几毫秒以上（一次 chunk 挂载）时，与其
 * 拖着整拍不画，不如把这一帧照实画出来并记一次撕裂——面板上看得见。
 *
 * 写成纯函数、把等待注入进来，是为了能在 Node 里用真的两段字节单测。
 */

import type { RenderCameraBuffer } from '../RenderCameraBuffer';
import type { RenderTransformBuffer } from '../RenderTransformBuffer';

export interface PairedFrameIds {
  /** 兑现进渲染世界的 transform 帧号。 */
  transformFrameId: number;
  /** 读到的机位帧号。 */
  cameraFrameId: number;
  /** 机位那一面自称配的 transform 帧号。 */
  pairedTransformFrameId: number;
  /** 重试之后仍对不上号：这一帧画出来的相机与世界不是同一帧。 */
  torn: boolean;
  /** 为了对上号重读了几次。 */
  retries: number;
}

export interface PairedFrameSources {
  readonly transforms: Pick<RenderTransformBuffer, 'frameId'>;
  readonly camera: Pick<RenderCameraBuffer, 'frameId' | 'pairedTransformFrameId' | 'waitForFrame'>;
  /** 把当前读面的 transform 兑现到渲染世界。 */
  submitTransforms(): void;
  /** 把当前读面的机位读走。 */
  readCamera(): void;
}

/** 等机位翻面最多等这么久（毫秒）。主线程两次翻面之间通常只有几十微秒。 */
export const PAIRED_FRAME_WAIT_MS = 2;
/** 最多重读几次。两次之后还对不上，主线程就是真的卡住了，照实画、记撕裂。 */
export const PAIRED_FRAME_MAXIMUM_RETRIES = 2;

export function consumePairedFrame(
  sources: PairedFrameSources,
  out: PairedFrameIds,
  waitMs = PAIRED_FRAME_WAIT_MS,
  maximumRetries = PAIRED_FRAME_MAXIMUM_RETRIES,
): PairedFrameIds {
  let retries = 0;
  for (;;) {
    const transformFrameId = sources.transforms.frameId;
    sources.submitTransforms();
    const cameraFrameId = sources.camera.frameId;
    sources.readCamera();
    const paired = sources.camera.pairedTransformFrameId;
    out.transformFrameId = transformFrameId;
    out.cameraFrameId = cameraFrameId;
    out.pairedTransformFrameId = paired;
    out.retries = retries;
    if (paired === transformFrameId) {
      out.torn = false;
      return out;
    }
    if (retries >= maximumRetries) {
      out.torn = true;
      return out;
    }
    retries += 1;
    // transform 已经翻到下一帧、机位还没：等机位那一面。翻面顺序被写反的另一种
    // 对不上（机位配的号更大）不用等，直接重读 transform 就追上了。
    if (paired < transformFrameId) sources.camera.waitForFrame(cameraFrameId, waitMs);
  }
}

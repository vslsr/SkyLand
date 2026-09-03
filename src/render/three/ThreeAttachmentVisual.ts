import * as THREE from 'three';
import { NULL_PROXY_ID, type ProxyId } from '../RenderScene';
import type { RenderTransformBuffer } from '../RenderTransformBuffer';
import type { ThreeMeshProxy } from './ThreeMeshProxy';

/**
 * 让子 proxy 的表现层继承父 proxy 的 `visualRoot` 波动，但不动任何一个权威 root
 * （实现路径文档 §1.75）。
 *
 * 这里以前是 `AttachmentVisualSystem`——**Actor 世界里唯一真正依赖「翻面已经发生」
 * 的 System**。它读的是父子两级的 `matrixWorld`，而那是 `submitTransforms` 刚摆好的，
 * 于是 publish/submit 被夹在写 SoA 与它之间，整个 Actor 世界都拆不进 worker。
 *
 * 它需要的东西只有一样：父子关系。而父子关系本来就在 SoA 的 parents 段里。
 * 搬进渲染世界之后那个夹心就没了。
 */
export class ThreeAttachmentVisual {
  private readonly inverseParent = new THREE.Matrix4();
  private readonly inverseChild = new THREE.Matrix4();
  private readonly desiredWorld = new THREE.Matrix4();
  private readonly localVisual = new THREE.Matrix4();
  /** 逐帧重建的 parent → children 邻接表。复用容器，不每帧分配。 */
  private readonly children = new Map<ProxyId, ProxyId[]>();
  private readonly roots: ProxyId[] = [];

  public update(
    live: readonly ThreeMeshProxy[],
    resolve: (id: ProxyId) => ThreeMeshProxy | undefined,
    transforms: RenderTransformBuffer,
  ): void {
    for (const list of this.children.values()) list.length = 0;
    this.roots.length = 0;
    for (const proxy of live) {
      const attachment = proxy.attachmentVisualRoot;
      attachment.position.set(0, 0, 0);
      attachment.quaternion.identity();
      attachment.scale.set(1, 1, 1);
      attachment.updateMatrix();

      const parent = transforms.readParent(proxy.id);
      if (parent === NULL_PROXY_ID || !resolve(parent)) {
        this.roots.push(proxy.id);
        continue;
      }
      let list = this.children.get(parent);
      if (!list) {
        list = [];
        this.children.set(parent, list);
      }
      list.push(proxy.id);
    }

    for (const root of this.roots) this.updateSubtree(root, undefined, resolve);
  }

  /** 槽位复用时邻接表要跟着清，否则新 proxy 会继承上一个 proxy 的子节点列表。 */
  public forget(id: ProxyId): void {
    this.children.delete(id);
  }

  /** 父节点顺着递归传下去，不回查——邻接表只有「父 → 子」一个方向。 */
  private updateSubtree(
    id: ProxyId,
    parent: ThreeMeshProxy | undefined,
    resolve: (id: ProxyId) => ThreeMeshProxy | undefined,
  ): void {
    const render = resolve(id);
    if (render && parent) this.compose(render, parent);
    for (const child of this.children.get(id) ?? []) this.updateSubtree(child, render, resolve);
  }

  private compose(render: ThreeMeshProxy, parentRender: ThreeMeshProxy): void {
    parentRender.root.updateWorldMatrix(true, false);
    parentRender.visualRoot.updateWorldMatrix(true, false);
    render.root.updateWorldMatrix(true, false);

    // desired = parentVisualWorld * inverse(parentAuthorityWorld) * childAuthorityWorld
    this.inverseParent.copy(parentRender.root.matrixWorld).invert();
    this.desiredWorld.copy(parentRender.visualRoot.matrixWorld)
      .multiply(this.inverseParent)
      .multiply(render.root.matrixWorld);
    this.inverseChild.copy(render.root.matrixWorld).invert();
    this.localVisual.copy(this.inverseChild).multiply(this.desiredWorld);
    this.localVisual.decompose(
      render.attachmentVisualRoot.position,
      render.attachmentVisualRoot.quaternion,
      render.attachmentVisualRoot.scale,
    );
    render.attachmentVisualRoot.updateMatrix();
    render.attachmentVisualRoot.updateWorldMatrix(false, true);
  }
}

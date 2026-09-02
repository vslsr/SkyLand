import { ActorComponent } from '../../../shared/actor/ActorComponent.mjs';
import type { GuidePathComponent } from '../../../shared/actor/components/GuidePathComponent.mjs';
import { GuidePath } from '../../guidance/index';

export const GUIDE_PATH_VISUAL_COMPONENT = 'guide-path-visual';

/** 客户端专用表现；权威路径数据只来自共享 GuidePathComponent。 */
export class GuidePathVisualComponent extends ActorComponent {
  public readonly guide: GuidePath;
  private appliedPathRevision = -1;
  private appliedRevision = -1;

  public constructor(private readonly state: GuidePathComponent) {
    super(GUIDE_PATH_VISUAL_COMPONENT);
    this.guide = new GuidePath({
      points: state.points as Array<[number, number, number]>,
      curve: state.curve,
      lineColor: state.lineColor,
      shadowColor: state.shadowColor,
      markerColor: state.markerColor,
      lineWidth: state.lineWidth,
      dashLength: state.dashLength,
      gapLength: state.gapLength,
      dashSpeed: state.dashSpeed,
      markerSize: state.markerSize,
    });
  }

  public sync(): void {
    if (this.state.pathRevision !== this.appliedPathRevision) {
      this.guide.setPath(
        this.state.points as Array<[number, number, number]>,
        this.state.curve,
        this.state.markerColor,
      );
      this.appliedPathRevision = this.state.pathRevision;
    }
    if (this.state.revision !== this.appliedRevision) {
      this.guide.setCurrentMarkerIndex(this.state.currentPointIndex);
      this.guide.setEnabled(this.state.enabled);
      this.appliedRevision = this.state.revision;
    }
  }

  public update(deltaSeconds: number): void {
    this.guide.update(deltaSeconds);
  }

  public setResolution(width: number, height: number): void {
    this.guide.setResolution(width, height);
  }

  public override onEndPlay(): void {
    this.guide.dispose();
  }
}

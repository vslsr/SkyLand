import type { Actor, ActorWorld } from '../../../shared/actor/index.mjs';
import {
  FIRE_VISUAL_COMPONENT,
  type FireVisualComponent,
} from '../components/FireVisualComponent';

/** 复刻参考壁炉的 CPU 动态 LineLoop；只改 visualRoot 下的顶点和火星。 */
export class FireVisualSystem {
  public update(world: ActorWorld, deltaSeconds: number, elapsedSeconds: number): void {
    const smoothing = 1 - Math.exp(-7 * Math.max(0, Math.min(deltaSeconds, 0.1)));
    for (const actor of world.query(FIRE_VISUAL_COMPONENT) as Actor[]) {
      const fire = actor.requireComponent(FIRE_VISUAL_COMPONENT) as FireVisualComponent;
      fire.intensity += (fire.targetIntensity - fire.intensity) * smoothing;
      if (Math.abs(fire.targetIntensity - fire.intensity) < 0.002) {
        fire.intensity = fire.targetIntensity;
      }
      const power = Math.max(0, Math.min(1, fire.intensity));
      fire.rig.root.visible = power > 0.01;
      if (!fire.rig.root.visible) continue;
      for (const flame of fire.rig.flames) this.updateFlame(flame, elapsedSeconds, power);
      for (const spark of fire.rig.sparks) {
        const progress = (elapsedSeconds * 0.22 + spark.phase) % 1;
        spark.object.position.set(
          spark.x + spark.drift * progress
            + Math.sin(elapsedSeconds * 2.5 + spark.phase * 9) * 0.04,
          spark.y + progress * spark.rise,
          spark.z + Math.cos(elapsedSeconds * 2 + spark.phase * 7) * 0.1,
        );
        const scale = ((1 - progress) * 0.9 + 0.15) * (0.35 + 0.65 * power);
        spark.object.scale.setScalar(scale);
      }
    }
  }

  private updateFlame(
    flame: FireVisualComponent['rig']['flames'][number],
    time: number,
    power: number,
  ): void {
    const positions = flame.position.array as Float32Array;
    const height = flame.height * power;
    const widthScale = 0.3 + 0.7 * power;
    let cursor = 0;
    const writePoint = (step: number, side: number): void => {
      const t = step / flame.segments;
      const width = flame.width * widthScale * Math.sin(Math.PI * (0.16 + 0.84 * t));
      const wobbleX = Math.sin(t * 5.2 - time * flame.speed + flame.phase)
        * 0.028 * t * power;
      const wobbleZ = Math.sin(t * 4 - time * flame.speed * 0.7 + flame.phase * 1.7)
        * 0.02 * t * power;
      positions[cursor++] = flame.x + wobbleX + width * side;
      positions[cursor++] = flame.y + t * height;
      positions[cursor++] = flame.z + wobbleZ;
    };
    for (let step = 0; step <= flame.segments; step += 1) writePoint(step, 1);
    for (let step = flame.segments; step >= 0; step -= 1) writePoint(step, -1);
    flame.position.needsUpdate = true;
  }
}

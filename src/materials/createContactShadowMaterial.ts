import * as THREE from 'three';

/**
 * 接触阴影的共享环境状态。
 *
 * 和共享墨线材质一样，同一时刻只有一个场景在跑，所以这里用一份模块级 uniform
 * 承载太阳方向与阴影强度；任何 Actor 模型都可以直接建一块接触阴影，不需要把
 * 场景 runtime 一路透传到每个模型工厂里。写入方仍然只有天气系统一个。
 */
export const CONTACT_SHADOW_UNIFORMS = {
  uSunDirection: { value: new THREE.Vector3(-0.55, 0.9, 0.35).normalize() },
  /** 直射光有多"硬"：晴朗正午接近 1，阴天与夜里趋近 0。 */
  uShadowStrength: { value: 0.85 },
  /** 阴影自身的染色，取当前环境光的色相。 */
  uShadowTint: { value: new THREE.Color(0xffffff) },
};

const VERTEX_SHADER = /* glsl */ `
  uniform vec3 uSunDirection;

  varying vec2 vShadowUv;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vec3 origin = modelMatrix[3].xyz;
    vec2 offset = worldPosition.xz - origin.xz;

    // 太阳压低时影子沿背光方向拉长并整体挪开，正午则收回到脚下。
    vec2 sunXZ = uSunDirection.xz;
    float sunLength = length(sunXZ);
    if (sunLength > 0.0001) {
      vec2 lightAxis = sunXZ / sunLength;
      float elevation = max(uSunDirection.y, 0.12);
      float stretch = clamp(sunLength / elevation, 0.0, 2.4);
      float along = dot(offset, lightAxis);
      vec2 across = offset - lightAxis * along;
      offset = across + lightAxis * along * (1.0 + stretch * 0.55);
      offset -= lightAxis * stretch * 0.12;
    }

    worldPosition.xz = origin.xz + offset;
    vShadowUv = uv;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uShadowTint;
  uniform float uOpacity;
  uniform float uShadowStrength;

  varying vec2 vShadowUv;

  void main() {
    // 软边比硬圆盘更像接触阴影，也不会在地形起伏处露出生硬的边。
    float radius = length(vShadowUv - 0.5) * 2.0;
    float falloff = 1.0 - smoothstep(0.35, 1.0, radius);
    float alpha = uOpacity * uShadowStrength * falloff;
    if (alpha <= 0.002) discard;
    gl_FragColor = vec4(uColor * uShadowTint, alpha);
  }
`;

export interface ContactShadowOptions {
  /** 影子最深时的不透明度。 */
  opacity?: number;
}

/**
 * Actor 脚下的假接触阴影。
 *
 * 没有实时阴影贴图，但方向、长度和浓度都跟着房间权威时刻走：清晨与黄昏拉出
 * 长影，阴天散射光下自然变淡，夜里几乎消失。顶点位移在世界空间完成，所以
 * 模型自己怎么摆都不影响拉伸方向。
 *
 * 浓度走 `setOpacity` 而不是 `Material.opacity`：动画和形变逻辑要改的是这块
 * 影子自己的深浅，环境给出的直射光硬度是另一路 uniform，两者相乘。
 */
export class ContactShadowMaterial extends THREE.ShaderMaterial {
  public constructor(
    color: THREE.ColorRepresentation,
    options: ContactShadowOptions = {},
  ) {
    super({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uOpacity: { value: options.opacity ?? 0.18 },
        uSunDirection: CONTACT_SHADOW_UNIFORMS.uSunDirection,
        uShadowStrength: CONTACT_SHADOW_UNIFORMS.uShadowStrength,
        uShadowTint: CONTACT_SHADOW_UNIFORMS.uShadowTint,
      },
      transparent: true,
      depthWrite: false,
    });
  }

  public setOpacity(value: number): void {
    this.uniforms.uOpacity.value = value;
  }
}

export function createContactShadowMaterial(
  color: THREE.ColorRepresentation,
  options: ContactShadowOptions = {},
): ContactShadowMaterial {
  return new ContactShadowMaterial(color, options);
}

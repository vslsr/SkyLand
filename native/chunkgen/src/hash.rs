//! 整数哈希与值噪声。
//!
//! 与 `shared/world/hash.mjs` 是同一套算法的两份实现，必须逐位一致：
//! 服务端用 JS 算、客户端用这里算，两边算出的世界不同就意味着
//! 「有人看得见那棵树、有人看不见」。所以这里只用 32 位整数运算，
//! 不引入任何浮点，wrapping_mul 与 JS 的 Math.imul 在位级等价。

/// 四路混合的 32 位哈希。
#[inline]
pub fn hash32(seed: u32, a: u32, b: u32, c: u32) -> u32 {
    let mut h = seed ^ 0x9e37_79b9;
    h = (h ^ a).wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = (h ^ b).wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    h = (h ^ c).wrapping_mul(0x27d4_eb2f);
    h ^= h >> 15;
    h
}

/// 值噪声格点的取值上限。
const NOISE_SCALE: u32 = 255;

#[inline]
fn lattice_value(seed: u32, lattice_x: i32, lattice_y: i32) -> u32 {
    hash32(seed, lattice_x as u32, lattice_y as u32, 0x51ed_270b) & NOISE_SCALE
}

/// 定点 smoothstep，把 [0, size) 的位置映射成同区间内的平滑权重。
#[inline]
fn smooth_weight(value: u32, size: u32) -> u32 {
    let squared = value * value;
    (3 * squared * size - 2 * squared * value) / (size * size)
}

/// 整数双线性值噪声，返回 [0, 255]。shift 不要超过 6，否则中间结果会溢出。
pub fn value_noise(seed: u32, x: i32, y: i32, shift: i32) -> u32 {
    let size = 1i32 << shift;
    let lattice_x = x >> shift;
    let lattice_y = y >> shift;
    let weight_x = smooth_weight((x - (lattice_x << shift)) as u32, size as u32);
    let weight_y = smooth_weight((y - (lattice_y << shift)) as u32, size as u32);
    let size = size as u32;

    let corner00 = lattice_value(seed, lattice_x, lattice_y);
    let corner10 = lattice_value(seed, lattice_x + 1, lattice_y);
    let corner01 = lattice_value(seed, lattice_x, lattice_y + 1);
    let corner11 = lattice_value(seed, lattice_x + 1, lattice_y + 1);

    let top = (corner00 * (size - weight_x) + corner10 * weight_x) / size;
    let bottom = (corner01 * (size - weight_x) + corner11 * weight_x) / size;
    (top * (size - weight_y) + bottom * weight_y) / size
}

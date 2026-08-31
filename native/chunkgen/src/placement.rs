//! chunk 物件的放置算法。
//!
//! 与 `shared/world/chunkContent.mjs` 是同一个算法的两份实现。
//! 全程整数运算：坐标用毫米、朝向用毫弧度、缩放用千分数，
//! 因此 JS 参考实现与这里的结果逐位相同，`server/tests` 里有测试锁死这一点。
//! 一旦两边分裂，「静态物件不走网络」这个前提就不成立了。

use crate::hash::{hash32, value_noise};

/// 一条放置记录占用的整数个数：kind, x_mm, z_mm, rotation_mrad, scale_thousandths。
pub const PROP_STRIDE: usize = 5;

/// 单个 chunk 的物件数量上限，等于放置格总数。
pub const MAX_PROPS: usize = (PROP_GRID * PROP_GRID) as usize;

pub const KIND_TREE: usize = 0;
pub const KIND_GRASS: usize = 1;
pub const KIND_ROCK: usize = 2;
pub const KIND_COUNT: usize = 3;

const CHUNK_SIZE_MM: i32 = 32_000;
const PROP_GRID: i32 = 8;
const PROP_CELL_SIZE_MM: i32 = CHUNK_SIZE_MM / PROP_GRID;
const PROP_MARGIN_MM: i32 = 600;
const JITTER_SPAN_MM: u32 = (PROP_CELL_SIZE_MM - PROP_MARGIN_MM * 2) as u32;

const DENSITY_SHIFT: i32 = 4;
const DENSITY_SALT: u32 = 0x1f3a_5b7c;
const OCCUPANCY_SALT: u32 = 0x2c9f_13a5;
const JITTER_SALT: u32 = 0x6b17_d4e9;
const SIZE_SALT: u32 = 0x3ea7_7b21;

const BASE_OCCUPANCY: u32 = 96;
const OCCUPANCY_FROM_DENSITY: u32 = 48;
const BASE_TREE_SHARE: u32 = 16;
const TREE_SHARE_FROM_DENSITY: u32 = 104;
const ROCK_SHARE: u32 = 32;
const TWO_PI_MRAD: u32 = 6283;

const SCALE_MINIMUM: [u32; KIND_COUNT] = [820, 780, 700];
const SCALE_MAXIMUM: [u32; KIND_COUNT] = [1360, 1250, 1400];

/// 生成一个 chunk 的全部物件，写入 `out`，返回物件数量。
/// `out` 的长度必须不小于 `MAX_PROPS * PROP_STRIDE`。
pub fn generate_props(seed: u32, chunk_x: i32, chunk_z: i32, out: &mut [i32]) -> u32 {
    let origin_x = chunk_x * CHUNK_SIZE_MM;
    let origin_z = chunk_z * CHUNK_SIZE_MM;
    let mut count = 0usize;

    for cell_z in 0..PROP_GRID {
        for cell_x in 0..PROP_GRID {
            let global_cell_x = chunk_x * PROP_GRID + cell_x;
            let global_cell_z = chunk_z * PROP_GRID + cell_z;

            let density = value_noise(
                seed ^ DENSITY_SALT,
                global_cell_x,
                global_cell_z,
                DENSITY_SHIFT,
            );
            let occupancy = BASE_OCCUPANCY + (density * OCCUPANCY_FROM_DENSITY) / 255;

            let occupancy_hash = hash32(
                seed,
                global_cell_x as u32,
                global_cell_z as u32,
                OCCUPANCY_SALT,
            );
            if (occupancy_hash & 0xff) >= occupancy {
                continue;
            }

            let tree_share = BASE_TREE_SHARE + (density * TREE_SHARE_FROM_DENSITY) / 255;
            let kind_roll = (occupancy_hash >> 8) & 0xff;
            let kind = if kind_roll < tree_share {
                KIND_TREE
            } else if kind_roll < tree_share + ROCK_SHARE {
                KIND_ROCK
            } else {
                KIND_GRASS
            };

            let jitter_hash = hash32(seed, global_cell_x as u32, global_cell_z as u32, JITTER_SALT);
            let size_hash = hash32(seed, global_cell_x as u32, global_cell_z as u32, SIZE_SALT);
            let minimum = SCALE_MINIMUM[kind];
            let span = SCALE_MAXIMUM[kind] - minimum + 1;

            let offset = count * PROP_STRIDE;
            out[offset] = kind as i32;
            out[offset + 1] = origin_x
                + cell_x * PROP_CELL_SIZE_MM
                + PROP_MARGIN_MM
                + (jitter_hash % JITTER_SPAN_MM) as i32;
            out[offset + 2] = origin_z
                + cell_z * PROP_CELL_SIZE_MM
                + PROP_MARGIN_MM
                + ((jitter_hash >> 12) % JITTER_SPAN_MM) as i32;
            out[offset + 3] = ((size_hash >> 8) % TWO_PI_MRAD) as i32;
            out[offset + 4] = (minimum + size_hash % span) as i32;
            count += 1;
        }
    }

    count as u32
}

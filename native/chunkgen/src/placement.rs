//! chunk 物件的放置算法。
//!
//! 与 `shared/world/chunkContent.mjs` 是同一个算法的两份实现。
//! 全程整数运算：坐标用毫米、朝向用毫弧度、缩放用千分数，
//! 因此 JS 参考实现与这里的结果逐位相同，`server/tests` 里有测试锁死这一点。
//! 一旦两边分裂，「静态物件不走网络」这个前提就不成立了。

use crate::biome::TERRAIN_BIOME_COUNT;
use crate::hash::{hash32, value_noise};
use crate::terrain::{
    ground_y_mm, terrain_cell_at_mm, TERRAIN_SHAPE_FLAT, TERRAIN_SURFACE_GROUND,
};

/// 一条放置记录占用的整数个数：kind, x_mm, z_mm, rotation_mrad, scale_thousandths, y_mm。
/// y 追加在末尾，既有字段下标保持稳定。
pub const PROP_STRIDE: usize = 6;

/// 单个 chunk 的物件数量上限，等于放置格总数。
pub const MAX_PROPS: usize = (PROP_GRID * PROP_GRID) as usize;

pub const KIND_TREE: usize = 0;
pub const KIND_GRASS: usize = 1;
pub const KIND_ROCK: usize = 2;
pub const KIND_MUSHROOM: usize = 3;
pub const KIND_COUNT: usize = 4;

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
const MUSHROOM_PLANT_SHARE_NUMERATOR: u32 = 3;
const PLANT_SHARE_DENOMINATOR: u32 = 7;
const TWO_PI_MRAD: u32 = 6283;

const SCALE_MINIMUM: [u32; KIND_COUNT] = [820, 780, 700, 850];
const SCALE_MAXIMUM: [u32; KIND_COUNT] = [1360, 1250, 1400, 1150];

/// 每种地皮的物件风格，字段与 `chunkContent.mjs` 的 `BIOME_PROP_STYLE` 逐项对应。
struct BiomePropStyle {
    occupancy: u32,
    tree: u32,
    rock: u32,
    mushroom: u32,
    grass: u32,
}

/// 下标是地皮值。255 表示与草原一致，0 表示这种地皮上不长。
/// 草原一行全 255，草地上的世界因此与引入群系之前逐位相同。
const BIOME_PROP_STYLE: [BiomePropStyle; TERRAIN_BIOME_COUNT] = [
    // 草原
    BiomePropStyle { occupancy: 255, tree: 255, rock: 255, mushroom: 255, grass: 255 },
    // 沙地
    BiomePropStyle { occupancy: 105, tree: 70, rock: 380, mushroom: 0, grass: 45 },
    // 烂泥地
    BiomePropStyle { occupancy: 240, tree: 70, rock: 60, mushroom: 420, grass: 200 },
    // 雪地
    BiomePropStyle { occupancy: 135, tree: 210, rock: 260, mushroom: 0, grass: 35 },
    // 石头地
    BiomePropStyle { occupancy: 175, tree: 45, rock: 900, mushroom: 90, grass: 90 },
];

/// 越界地皮退回草原，与 JS 的 `biomePropStyle` 同义。
#[inline]
fn biome_prop_style(biome: u32) -> &'static BiomePropStyle {
    let index = if (biome as usize) < TERRAIN_BIOME_COUNT {
        biome as usize
    } else {
        0
    };
    &BIOME_PROP_STYLE[index]
}

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
            let occupancy_hash = hash32(
                seed,
                global_cell_x as u32,
                global_cell_z as u32,
                OCCUPANCY_SALT,
            );
            let jitter_hash = hash32(seed, global_cell_x as u32, global_cell_z as u32, JITTER_SALT);

            // 先落点、再问地皮：占用率与种类都跟着脚下那一格的地皮走。
            let x_mm = origin_x
                + cell_x * PROP_CELL_SIZE_MM
                + PROP_MARGIN_MM
                + (jitter_hash % JITTER_SPAN_MM) as i32;
            let z_mm = origin_z
                + cell_z * PROP_CELL_SIZE_MM
                + PROP_MARGIN_MM
                + ((jitter_hash >> 12) % JITTER_SPAN_MM) as i32;
            let terrain = terrain_cell_at_mm(seed, x_mm, z_mm);
            if terrain.surface != TERRAIN_SURFACE_GROUND || terrain.shape != TERRAIN_SHAPE_FLAT {
                continue;
            }

            let style = biome_prop_style(terrain.biome);
            let occupancy =
                (BASE_OCCUPANCY + (density * OCCUPANCY_FROM_DENSITY) / 255) * style.occupancy / 255;
            if (occupancy_hash & 0xff) >= occupancy {
                continue;
            }

            let tree_share =
                (BASE_TREE_SHARE + (density * TREE_SHARE_FROM_DENSITY) / 255) * style.tree / 255;
            let rock_share = ROCK_SHARE * style.rock / 255;
            let rock_limit = tree_share + rock_share;
            // u32 减法会回绕，所以这里必须显式钳住，不能照抄 256 - rock_limit。
            let plant_share = if rock_limit >= 256 { 0 } else { 256 - rock_limit };
            let mushroom_plants =
                plant_share * MUSHROOM_PLANT_SHARE_NUMERATOR / PLANT_SHARE_DENOMINATOR;
            let mushroom_share = mushroom_plants * style.mushroom / 255;
            let grass_share = (plant_share - mushroom_plants) * style.grass / 255;
            let kind_roll = ((occupancy_hash >> 8) & 0xff)
                * (rock_limit + mushroom_share + grass_share)
                / 256;
            let kind = if kind_roll < tree_share {
                KIND_TREE
            } else if kind_roll < rock_limit {
                KIND_ROCK
            } else if kind_roll < rock_limit + mushroom_share {
                KIND_MUSHROOM
            } else {
                KIND_GRASS
            };

            let size_hash = hash32(seed, global_cell_x as u32, global_cell_z as u32, SIZE_SALT);
            let minimum = SCALE_MINIMUM[kind];
            let span = SCALE_MAXIMUM[kind] - minimum + 1;

            let offset = count * PROP_STRIDE;
            out[offset] = kind as i32;
            out[offset + 1] = x_mm;
            out[offset + 2] = z_mm;
            out[offset + 3] = ((size_hash >> 8) % TWO_PI_MRAD) as i32;
            out[offset + 4] = (minimum + size_hash % span) as i32;
            out[offset + 5] = ground_y_mm(terrain);
            count += 1;
        }
    }

    count as u32
}

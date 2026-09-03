//! 确定性台阶地形的 Rust 镜像。
//!
//! 必须与 `shared/world/terrainContent.mjs` 逐位一致。这里保留物件放置所需的
//! 表面、形状和整数高度，外加打包进格 code 的群系（`biome.rs`）；完整网格仍由
//! 共享 JS 生成并渲染。

use crate::biome::terrain_biome_at;
use crate::hash::{hash32, value_noise};

pub const TERRAIN_SURFACE_GROUND: u32 = 0;
pub const TERRAIN_SURFACE_WATER: u32 = 1;
pub const TERRAIN_SHAPE_FLAT: u32 = 0;

const TERRAIN_SHAPE_RAMP_NORTH: u32 = 1;
const TERRAIN_SHAPE_RAMP_EAST: u32 = 2;
const TERRAIN_SHAPE_RAMP_SOUTH: u32 = 3;
const TERRAIN_SHAPE_RAMP_WEST: u32 = 4;
const TERRAIN_SHAPE_CORNER_HIGH_NORTH_EAST: u32 = 5;
const TERRAIN_SHAPE_CORNER_HIGH_SOUTH_EAST: u32 = 6;
const TERRAIN_SHAPE_CORNER_HIGH_SOUTH_WEST: u32 = 7;
const TERRAIN_SHAPE_CORNER_HIGH_NORTH_WEST: u32 = 8;
const TERRAIN_SHAPE_CORNER_LOW_NORTH_EAST: u32 = 9;
const TERRAIN_SHAPE_CORNER_LOW_SOUTH_EAST: u32 = 10;
const TERRAIN_SHAPE_CORNER_LOW_SOUTH_WEST: u32 = 11;
const TERRAIN_SHAPE_CORNER_LOW_NORTH_WEST: u32 = 12;
const TERRAIN_CARDINAL_NEIGHBORS: [(i32, i32, u32); 4] = [
    (0, 1, TERRAIN_SHAPE_RAMP_NORTH),
    (1, 0, TERRAIN_SHAPE_RAMP_EAST),
    (0, -1, TERRAIN_SHAPE_RAMP_SOUTH),
    (-1, 0, TERRAIN_SHAPE_RAMP_WEST),
];
const TERRAIN_LOW_CORNER_SHAPES: [u32; 4] = [
    TERRAIN_SHAPE_CORNER_LOW_SOUTH_WEST,
    TERRAIN_SHAPE_CORNER_LOW_NORTH_WEST,
    TERRAIN_SHAPE_CORNER_LOW_NORTH_EAST,
    TERRAIN_SHAPE_CORNER_LOW_SOUTH_EAST,
];
const TERRAIN_DIAGONAL_NEIGHBORS: [(i32, i32, u32); 4] = [
    (1, 1, TERRAIN_SHAPE_CORNER_HIGH_NORTH_EAST),
    (1, -1, TERRAIN_SHAPE_CORNER_HIGH_SOUTH_EAST),
    (-1, -1, TERRAIN_SHAPE_CORNER_HIGH_SOUTH_WEST),
    (-1, 1, TERRAIN_SHAPE_CORNER_HIGH_NORTH_WEST),
];
/// 打包格式与 JS 的 `encodeTerrainCell` 必须一致：
/// 高 8 位是有符号高度层，第 4 位是表面，低 4 位是形状。
const TERRAIN_SHAPE_MASK: i32 = 0b1111;
const TERRAIN_SURFACE_SHIFT: i32 = 4;
const TERRAIN_BIOME_SHIFT: i32 = 5;
const TERRAIN_BIOME_MASK: i32 = 0b111;
const TERRAIN_HEIGHT_SHIFT: i32 = 8;
const TERRAIN_MINIMUM_HEIGHT_LEVEL: i32 = -128;
const TERRAIN_MAXIMUM_HEIGHT_LEVEL: i32 = 127;

const TERRAIN_CELL_SIZE_MM: i32 = 2_000;
const TERRAIN_HEIGHT_STEP_MM: i32 = 1_000;
const TERRAIN_NOISE_SALT: u32 = 0x74c3_19ad;
const TERRAIN_SLOPE_SALT: u32 = 0x2b91_6e47;
const TERRAIN_NOISE_SHIFT: i32 = 5;
const SPAWN_SAFE_RADIUS_CELLS: i32 = 5;

#[derive(Clone, Copy)]
pub struct TerrainCell {
    pub height_level: i32,
    pub surface: u32,
    pub shape: u32,
    /// 地皮。不影响高度、形状与可通行性，放置算法目前也不读它；
    /// 它进 `TerrainCell` 是因为格 code 里有它，跨端比对逐位覆盖这一段。
    pub biome: u32,
}

#[inline]
fn base_level_at(seed: u32, global_cell_x: i32, global_cell_z: i32) -> i32 {
    if global_cell_x.abs() <= SPAWN_SAFE_RADIUS_CELLS
        && global_cell_z.abs() <= SPAWN_SAFE_RADIUS_CELLS
    {
        return 0;
    }

    let noise = value_noise(
        seed ^ TERRAIN_NOISE_SALT,
        global_cell_x,
        global_cell_z,
        TERRAIN_NOISE_SHIFT,
    );
    if noise < 28 {
        -2
    } else if noise < 72 {
        -1
    } else if noise < 166 {
        0
    } else if noise < 220 {
        1
    } else {
        2
    }
}

#[inline]
pub fn terrain_cell_at(seed: u32, global_cell_x: i32, global_cell_z: i32) -> TerrainCell {
    let height_level = base_level_at(seed, global_cell_x, global_cell_z);
    // 群系与高度互不干涉：水底也带着它所在片区的地皮。
    let biome = terrain_biome_at(seed, global_cell_x, global_cell_z);
    if height_level < 0 {
        return TerrainCell {
            height_level,
            surface: TERRAIN_SURFACE_WATER,
            shape: TERRAIN_SHAPE_FLAT,
            biome,
        };
    }

    let first = (hash32(
        seed,
        global_cell_x as u32,
        global_cell_z as u32,
        TERRAIN_SLOPE_SALT,
    ) & 3) as usize;
    let mut higher_cardinal = [false; 4];
    for direction in 0..4 {
        let (delta_x, delta_z, _) = TERRAIN_CARDINAL_NEIGHBORS[direction];
        higher_cardinal[direction] =
            base_level_at(seed, global_cell_x + delta_x, global_cell_z + delta_z)
                == height_level + 1;
    }

    for offset in 0..4 {
        let direction = (first + offset) & 3;
        if higher_cardinal[direction] && higher_cardinal[(direction + 1) & 3] {
            return TerrainCell {
                height_level,
                surface: TERRAIN_SURFACE_GROUND,
                shape: TERRAIN_LOW_CORNER_SHAPES[direction],
                biome,
            };
        }
    }

    for offset in 0..4 {
        let direction = (first + offset) & 3;
        if higher_cardinal[direction] {
            return TerrainCell {
                height_level,
                surface: TERRAIN_SURFACE_GROUND,
                shape: TERRAIN_CARDINAL_NEIGHBORS[direction].2,
                biome,
            };
        }
    }

    for offset in 0..4 {
        let (delta_x, delta_z, shape) = TERRAIN_DIAGONAL_NEIGHBORS[(first + offset) & 3];
        if base_level_at(seed, global_cell_x + delta_x, global_cell_z + delta_z)
            == height_level + 1
        {
            return TerrainCell {
                height_level,
                surface: TERRAIN_SURFACE_GROUND,
                shape,
                biome,
            };
        }
    }

    TerrainCell {
        height_level,
        surface: TERRAIN_SURFACE_GROUND,
        shape: TERRAIN_SHAPE_FLAT,
        biome,
    }
}

#[inline]
pub fn terrain_cell_at_mm(seed: u32, x_mm: i32, z_mm: i32) -> TerrainCell {
    terrain_cell_at(
        seed,
        x_mm.div_euclid(TERRAIN_CELL_SIZE_MM),
        z_mm.div_euclid(TERRAIN_CELL_SIZE_MM),
    )
}

#[inline]
pub fn ground_y_mm(cell: TerrainCell) -> i32 {
    cell.height_level * TERRAIN_HEIGHT_STEP_MM
}

/// 把一格打包成与 JS `encodeTerrainCell` 逐位相同的整数。
///
/// 生成路径不走这里——放置算法直接用 `TerrainCell`。这个导出只为跨后端比对
/// 存在：物件只落在平地上，所以放置记录里的 y 永远采样不到斜坡、角点和水面，
/// 而那几支恰恰是形状选择里最容易分裂的部分。有了它，
/// `server/tests/terrainParity.test.mjs` 才能逐格扫过全部形状。
#[no_mangle]
pub extern "C" fn terrain_cell_code_at(seed: u32, global_cell_x: i32, global_cell_z: i32) -> i32 {
    let cell = terrain_cell_at(seed, global_cell_x, global_cell_z);
    // 与 JS 同样先钳制再取低 8 位：不钳制的话越界高度在两端会一个饱和一个回绕。
    let height = if cell.height_level < TERRAIN_MINIMUM_HEIGHT_LEVEL {
        TERRAIN_MINIMUM_HEIGHT_LEVEL
    } else if cell.height_level > TERRAIN_MAXIMUM_HEIGHT_LEVEL {
        TERRAIN_MAXIMUM_HEIGHT_LEVEL
    } else {
        cell.height_level
    };
    ((height & 0xff) << TERRAIN_HEIGHT_SHIFT)
        | (((cell.biome as i32) & TERRAIN_BIOME_MASK) << TERRAIN_BIOME_SHIFT)
        | (((cell.surface as i32) & 1) << TERRAIN_SURFACE_SHIFT)
        | ((cell.shape as i32) & TERRAIN_SHAPE_MASK)
}

//! 确定性台阶地形的 Rust 镜像。
//!
//! 必须与 `shared/world/terrainContent.mjs` 逐位一致。这里仅保留物件放置
//! 所需的表面、形状和整数高度，完整网格仍由共享 JS 生成并渲染。

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
    if height_level < 0 {
        return TerrainCell {
            height_level,
            surface: TERRAIN_SURFACE_WATER,
            shape: TERRAIN_SHAPE_FLAT,
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
            };
        }
    }

    TerrainCell {
        height_level,
        surface: TERRAIN_SURFACE_GROUND,
        shape: TERRAIN_SHAPE_FLAT,
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

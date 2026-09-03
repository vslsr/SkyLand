//! 确定性群系分区的 Rust 镜像。
//!
//! 必须与 `shared/world/terrainBiome.mjs` 逐位一致：群系写进格 code，
//! `server/tests/terrainParity.test.mjs` 会逐格比对两端的 code。
//!
//! 结构与 JS 侧相同——区块站点取最近者构成 Voronoi，站点再按温度 × 湿度查表。
//! 常量只要有一处对不上，两端就会在同一片地上铺出不同的地皮。

use crate::hash::{hash32, value_noise};

/// 地皮总数。与 JS 的 `TERRAIN_BIOME_COUNT` 一致，放置算法按它索引风格表。
pub const TERRAIN_BIOME_COUNT: usize = 5;

pub const TERRAIN_BIOME_GRASSLAND: u32 = 0;
pub const TERRAIN_BIOME_SAND: u32 = 1;
pub const TERRAIN_BIOME_MUD: u32 = 2;
pub const TERRAIN_BIOME_SNOW: u32 = 3;
pub const TERRAIN_BIOME_ROCK: u32 = 4;

const BIOME_REGION_SHIFT: i32 = 5;
const BIOME_REGION_SIZE: i32 = 1 << BIOME_REGION_SHIFT;
const BIOME_SITE_MARGIN: i32 = 8;
const BIOME_SITE_SPAN: i32 = BIOME_REGION_SIZE - BIOME_SITE_MARGIN * 2;
const BIOME_CLIMATE_SHIFT: i32 = 5;

const BIOME_SITE_SALT: u32 = 0x4d2c_8f13;
const BIOME_TEMPERATURE_SALT: u32 = 0x1a7b_e35d;
const BIOME_MOISTURE_SALT: u32 = 0x63f0_9c21;

const BIOME_VARIATION_MASK: u32 = 63;
const BIOME_VARIATION_HALF: i32 = 32;

const SNOW_TEMPERATURE_MAXIMUM: i32 = 78;
const SAND_TEMPERATURE_MINIMUM: i32 = 137;
const SAND_MOISTURE_MAXIMUM: i32 = 112;
const MUD_MOISTURE_MINIMUM: i32 = 172;
const ROCK_MOISTURE_MAXIMUM: i32 = 106;

#[inline]
fn site_hash(seed: u32, region_x: i32, region_z: i32) -> u32 {
    hash32(seed, region_x as u32, region_z as u32, BIOME_SITE_SALT)
}

#[inline]
fn site_x(region_x: i32, site_hash: u32) -> i32 {
    (region_x << BIOME_REGION_SHIFT)
        + BIOME_SITE_MARGIN
        + (site_hash % BIOME_SITE_SPAN as u32) as i32
}

#[inline]
fn site_z(region_z: i32, site_hash: u32) -> i32 {
    (region_z << BIOME_REGION_SHIFT)
        + BIOME_SITE_MARGIN
        + ((site_hash >> 8) % BIOME_SITE_SPAN as u32) as i32
}

#[inline]
fn clamp_climate(value: i32) -> i32 {
    if value < 0 {
        0
    } else if value > 255 {
        255
    } else {
        value
    }
}

#[inline]
fn site_temperature(seed: u32, x: i32, z: i32, site_hash: u32) -> i32 {
    clamp_climate(
        value_noise(seed ^ BIOME_TEMPERATURE_SALT, x, z, BIOME_CLIMATE_SHIFT) as i32
            + (((site_hash >> 16) & BIOME_VARIATION_MASK) as i32 - BIOME_VARIATION_HALF),
    )
}

#[inline]
fn site_moisture(seed: u32, x: i32, z: i32, site_hash: u32) -> i32 {
    clamp_climate(
        value_noise(seed ^ BIOME_MOISTURE_SALT, x, z, BIOME_CLIMATE_SHIFT) as i32
            + (((site_hash >> 24) & BIOME_VARIATION_MASK) as i32 - BIOME_VARIATION_HALF),
    )
}

#[inline]
fn biome_from_climate(temperature: i32, moisture: i32) -> u32 {
    if temperature <= SNOW_TEMPERATURE_MAXIMUM {
        return TERRAIN_BIOME_SNOW;
    }
    if temperature >= SAND_TEMPERATURE_MINIMUM && moisture <= SAND_MOISTURE_MAXIMUM {
        return TERRAIN_BIOME_SAND;
    }
    if moisture >= MUD_MOISTURE_MINIMUM {
        return TERRAIN_BIOME_MUD;
    }
    if moisture <= ROCK_MOISTURE_MAXIMUM {
        return TERRAIN_BIOME_ROCK;
    }
    TERRAIN_BIOME_GRASSLAND
}

/// 一格的群系。3×3 区块里取最近站点；站点内缩保证这个范围就是精确的 Voronoi。
pub fn terrain_biome_at(seed: u32, global_cell_x: i32, global_cell_z: i32) -> u32 {
    let region_x = global_cell_x >> BIOME_REGION_SHIFT;
    let region_z = global_cell_z >> BIOME_REGION_SHIFT;
    let mut nearest_distance = i32::MAX;
    let mut nearest_x = 0;
    let mut nearest_z = 0;
    let mut nearest_hash = 0;
    // 扫描顺序与 JS 相同：距离相等时先到的站点胜出，两端因此选中同一个。
    for offset_z in -1..=1 {
        for offset_x in -1..=1 {
            let candidate_region_x = region_x + offset_x;
            let candidate_region_z = region_z + offset_z;
            let hash = site_hash(seed, candidate_region_x, candidate_region_z);
            let x = site_x(candidate_region_x, hash);
            let z = site_z(candidate_region_z, hash);
            let delta_x = x - global_cell_x;
            let delta_z = z - global_cell_z;
            let distance = delta_x * delta_x + delta_z * delta_z;
            if distance < nearest_distance {
                nearest_distance = distance;
                nearest_x = x;
                nearest_z = z;
                nearest_hash = hash;
            }
        }
    }
    biome_from_climate(
        site_temperature(seed, nearest_x, nearest_z, nearest_hash),
        site_moisture(seed, nearest_x, nearest_z, nearest_hash),
    )
}

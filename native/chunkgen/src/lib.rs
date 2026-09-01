//! SkyLand 大世界的 chunk 生成与顶点合批。
//!
//! 职责分成两半：
//!
//! 1. **放置**：由种子和 chunk 坐标确定性地算出物件列表（见 `placement`）。
//!    这一半在 `shared/world/chunkContent.mjs` 有一份逐位一致的 JS 实现，
//!    服务端用 JS 那份，客户端用这份，两边算出的世界必须完全相同。
//! 2. **合批**：把模板几何体按每个物件的位置、朝向、缩放变换后，
//!    写进一整块连续的顶点缓冲。这才是 WASM 真正赚到的部分——
//!    每个 chunk 数万个浮点的矩阵变换与写入全部发生在线性内存里，
//!    JS 侧只需要把结果切片交给 GPU，不产生任何逐顶点的临时对象。
//!
//! 模板几何体本身由 JS 用 Three.js 生成后一次性上传到 `arena`，
//! 这样线稿风格的模型仍然由项目原有的 `src/models/` 定义，
//! 不需要在 Rust 里重写一遍圆锥圆柱的三角化。

#![no_std]

mod hash;
mod math;
mod placement;
mod terrain;

use core::panic::PanicInfo;
use core::ptr::addr_of_mut;
use placement::{generate_props, KIND_COUNT, MAX_PROPS, PROP_STRIDE};

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    loop {}
}

/// 地面铺块的模板下标，排在所有物件之后。
const TEMPLATE_GROUND: usize = KIND_COUNT;
const TEMPLATE_COUNT: usize = KIND_COUNT + 1;

/// 模板顶点的暂存区容量（f32 个数）。
const TEMPLATE_ARENA_F32: usize = 65_536;

/// 单个 chunk 合批后的顶点上限。按「64 个放置格全部是树」的最坏情况留量。
const MAX_FILL_VERTICES: usize = 32_768;
const MAX_LINE_VERTICES: usize = 16_384;

/// 与 `shared/world/worldConfig.mjs` 的 CHUNK_SIZE 一致。
const CHUNK_SIZE: f32 = 32.0;

/// 单个填充顶点在 arena 中占用的 f32 个数：位置、法线、颜色各三个。
///
/// 颜色随顶点走而不是随模板走，是为了让一棵树的树干与树冠保持各自的配色，
/// 同时整个 chunk 仍然只用一种材质、一次 draw call。
const TEMPLATE_FILL_STRIDE: usize = 9;

#[derive(Clone, Copy)]
struct Template {
    /// 填充顶点在 arena 中的起始下标，布局为 [px, py, pz, nx, ny, nz, r, g, b] × fill_count。
    fill_offset: u32,
    fill_count: u32,
    /// 轮廓线顶点在 arena 中的起始下标，布局为 [px, py, pz] × line_count。
    line_offset: u32,
    line_count: u32,
}

/// 未注册模板的占位值。全部字段保持为零很关键：整个 `STATE` 都是零初始化时，
/// 链接器才会把它放进 .bss，而不是把 1.6 MB 的零字节写进 wasm 的数据段。
const EMPTY_TEMPLATE: Template = Template {
    fill_offset: 0,
    fill_count: 0,
    line_offset: 0,
    line_count: 0,
};

struct State {
    seed: u32,
    templates: [Template; TEMPLATE_COUNT],
    arena: [f32; TEMPLATE_ARENA_F32],
    props: [i32; MAX_PROPS * PROP_STRIDE],
    prop_count: u32,
    fill_positions: [f32; MAX_FILL_VERTICES * 3],
    fill_normals: [f32; MAX_FILL_VERTICES * 3],
    fill_tints: [f32; MAX_FILL_VERTICES * 3],
    fill_count: u32,
    line_positions: [f32; MAX_LINE_VERTICES * 3],
    line_count: u32,
}

static mut STATE: State = State {
    seed: 0,
    templates: [EMPTY_TEMPLATE; TEMPLATE_COUNT],
    arena: [0.0; TEMPLATE_ARENA_F32],
    props: [0; MAX_PROPS * PROP_STRIDE],
    prop_count: 0,
    fill_positions: [0.0; MAX_FILL_VERTICES * 3],
    fill_normals: [0.0; MAX_FILL_VERTICES * 3],
    fill_tints: [0.0; MAX_FILL_VERTICES * 3],
    fill_count: 0,
    line_positions: [0.0; MAX_LINE_VERTICES * 3],
    line_count: 0,
};

/// wasm 是单线程的，全局状态用一份静态实例即可。
#[inline(always)]
fn state() -> &'static mut State {
    unsafe { &mut *addr_of_mut!(STATE) }
}

// ---------------------------------------------------------------- 内存布局查询

#[no_mangle]
pub extern "C" fn template_arena_ptr() -> u32 {
    unsafe { addr_of_mut!(STATE.arena) as u32 }
}

#[no_mangle]
pub extern "C" fn template_arena_capacity() -> u32 {
    TEMPLATE_ARENA_F32 as u32
}

#[no_mangle]
pub extern "C" fn template_count() -> u32 {
    TEMPLATE_COUNT as u32
}

#[no_mangle]
pub extern "C" fn ground_template_index() -> u32 {
    TEMPLATE_GROUND as u32
}

#[no_mangle]
pub extern "C" fn maximum_fill_vertices() -> u32 {
    MAX_FILL_VERTICES as u32
}

#[no_mangle]
pub extern "C" fn maximum_line_vertices() -> u32 {
    MAX_LINE_VERTICES as u32
}

#[no_mangle]
pub extern "C" fn prop_ptr() -> u32 {
    unsafe { addr_of_mut!(STATE.props) as u32 }
}

#[no_mangle]
pub extern "C" fn prop_count() -> u32 {
    state().prop_count
}

#[no_mangle]
pub extern "C" fn prop_stride() -> u32 {
    PROP_STRIDE as u32
}

#[no_mangle]
pub extern "C" fn fill_position_ptr() -> u32 {
    unsafe { addr_of_mut!(STATE.fill_positions) as u32 }
}

#[no_mangle]
pub extern "C" fn fill_normal_ptr() -> u32 {
    unsafe { addr_of_mut!(STATE.fill_normals) as u32 }
}

#[no_mangle]
pub extern "C" fn fill_tint_ptr() -> u32 {
    unsafe { addr_of_mut!(STATE.fill_tints) as u32 }
}

#[no_mangle]
pub extern "C" fn fill_vertex_count() -> u32 {
    state().fill_count
}

#[no_mangle]
pub extern "C" fn line_position_ptr() -> u32 {
    unsafe { addr_of_mut!(STATE.line_positions) as u32 }
}

#[no_mangle]
pub extern "C" fn line_vertex_count() -> u32 {
    state().line_count
}

// -------------------------------------------------------------------- 生命周期

/// 注册一个模板。顶点数据需要调用方先写进 `template_arena_ptr()` 指向的区域。
/// 返回 0 表示成功，负值表示下标越界或顶点区间超出 arena。
#[no_mangle]
pub extern "C" fn register_template(
    index: u32,
    fill_offset: u32,
    fill_count: u32,
    line_offset: u32,
    line_count: u32,
) -> i32 {
    let index = index as usize;
    if index >= TEMPLATE_COUNT {
        return -1;
    }
    if fill_offset as usize + fill_count as usize * TEMPLATE_FILL_STRIDE > TEMPLATE_ARENA_F32 {
        return -2;
    }
    if line_offset as usize + line_count as usize * 3 > TEMPLATE_ARENA_F32 {
        return -3;
    }

    state().templates[index] = Template {
        fill_offset,
        fill_count,
        line_offset,
        line_count,
    };
    0
}

#[no_mangle]
pub extern "C" fn set_seed(seed: u32) {
    state().seed = seed;
}

/// 生成并合批一个 chunk。返回 0 表示成功，-1 表示顶点缓冲不够用。
#[no_mangle]
pub extern "C" fn build_chunk(chunk_x: i32, chunk_z: i32) -> i32 {
    build_chunk_masked(chunk_x, chunk_z, 0, 0)
}

/// 生成并合批一个 chunk，同时跳过最多 64 个放置记录中的指定项。
/// 掩码只影响几何体写入，完整 props 仍会返回给碰撞与派生 Actor 使用。
#[no_mangle]
pub extern "C" fn build_chunk_masked(
    chunk_x: i32,
    chunk_z: i32,
    skip_low: u32,
    skip_high: u32,
) -> i32 {
    {
        let current = state();
        current.fill_count = 0;
        current.line_count = 0;
        current.prop_count = generate_props(current.seed, chunk_x, chunk_z, &mut current.props);
    }

    // 地面铺块以 chunk 中心为原点，先铺地再放物件，保证同一份缓冲里地面在最前。
    let center_x = chunk_x as f32 * CHUNK_SIZE + CHUNK_SIZE * 0.5;
    let center_z = chunk_z as f32 * CHUNK_SIZE + CHUNK_SIZE * 0.5;
    if !emit_template(TEMPLATE_GROUND, center_x, 0.0, center_z, 0.0, 1.0) {
        return -1;
    }

    let count = state().prop_count as usize;
    for index in 0..count {
        let skipped = if index < 32 {
            ((skip_low >> index) & 1) != 0
        } else {
            ((skip_high >> (index - 32)) & 1) != 0
        };
        if skipped {
            continue;
        }
        // 先把这条记录读进局部变量，再调用 emit_template，
        // 避免同时持有两份指向全局状态的可变引用。
        let (kind, x, y, z, rotation, scale) = {
            let current = state();
            let offset = index * PROP_STRIDE;
            (
                current.props[offset] as usize,
                current.props[offset + 1] as f32 / 1000.0,
                current.props[offset + 5] as f32 / 1000.0,
                current.props[offset + 2] as f32 / 1000.0,
                current.props[offset + 3] as f32 / 1000.0,
                current.props[offset + 4] as f32 / 1000.0,
            )
        };
        if kind >= KIND_COUNT {
            continue;
        }
        if !emit_template(kind, x, y, z, rotation, scale) {
            return -1;
        }
    }

    0
}

/// 把一个模板按绕 Y 轴旋转 + 等比缩放 + 平移写进输出缓冲。
/// 等比缩放不改变法线方向，所以法线只做旋转。
fn emit_template(
    index: usize,
    translate_x: f32,
    translate_y: f32,
    translate_z: f32,
    angle: f32,
    scale: f32,
) -> bool {
    let current = state();
    let template = current.templates[index];

    if current.fill_count as usize + template.fill_count as usize > MAX_FILL_VERTICES {
        return false;
    }
    if current.line_count as usize + template.line_count as usize > MAX_LINE_VERTICES {
        return false;
    }

    let (sine, cosine) = math::sin_cos(angle);

    let mut write = current.fill_count as usize * 3;
    let mut read = template.fill_offset as usize;
    for _ in 0..template.fill_count {
        let position_x = current.arena[read];
        let position_y = current.arena[read + 1];
        let position_z = current.arena[read + 2];
        let normal_x = current.arena[read + 3];
        let normal_y = current.arena[read + 4];
        let normal_z = current.arena[read + 5];
        let tint_red = current.arena[read + 6];
        let tint_green = current.arena[read + 7];
        let tint_blue = current.arena[read + 8];
        read += TEMPLATE_FILL_STRIDE;

        current.fill_positions[write] = scale * (cosine * position_x + sine * position_z) + translate_x;
        current.fill_positions[write + 1] = scale * position_y + translate_y;
        current.fill_positions[write + 2] = scale * (cosine * position_z - sine * position_x) + translate_z;
        current.fill_normals[write] = cosine * normal_x + sine * normal_z;
        current.fill_normals[write + 1] = normal_y;
        current.fill_normals[write + 2] = cosine * normal_z - sine * normal_x;
        current.fill_tints[write] = tint_red;
        current.fill_tints[write + 1] = tint_green;
        current.fill_tints[write + 2] = tint_blue;
        write += 3;
    }
    current.fill_count += template.fill_count;

    let mut write = current.line_count as usize * 3;
    let mut read = template.line_offset as usize;
    for _ in 0..template.line_count {
        let position_x = current.arena[read];
        let position_y = current.arena[read + 1];
        let position_z = current.arena[read + 2];
        read += 3;

        current.line_positions[write] = scale * (cosine * position_x + sine * position_z) + translate_x;
        current.line_positions[write + 1] = scale * position_y + translate_y;
        current.line_positions[write + 2] = scale * (cosine * position_z - sine * position_x) + translate_z;
        write += 3;
    }
    current.line_count += template.line_count;

    true
}

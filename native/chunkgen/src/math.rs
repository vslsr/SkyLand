//! 合批需要的最小三角函数。
//!
//! 目标平台是 `wasm32-unknown-unknown` 且 `no_std`，链接不到 libm，
//! 所以 `sin` / `cos` / `%` 这些会落到 libm 的运算一律不能用。
//! 这里只依赖加减乘除与比较，把角度归约到 [-π/4, π/4] 后做泰勒展开，
//! 误差约 1e-8 弧度，对摆放树木的朝向远远足够。

const HALF_PI: f32 = 1.570_796_3;

#[inline]
fn poly_sin(x: f32) -> f32 {
    let squared = x * x;
    x * (1.0
        - squared
            * (1.0 / 6.0 - squared * (1.0 / 120.0 - squared * (1.0 / 5040.0))))
}

#[inline]
fn poly_cos(x: f32) -> f32 {
    let squared = x * x;
    1.0 - squared * (0.5 - squared * (1.0 / 24.0 - squared * (1.0 / 720.0)))
}

/// 同时求正弦与余弦。入参必须是非负角度（本项目的朝向由毫弧度换算而来，
/// 天然落在 [0, 2π)），不做通用的区间归约。
pub fn sin_cos(angle: f32) -> (f32, f32) {
    let quadrant = (angle / HALF_PI + 0.5) as i32;
    let remainder = angle - quadrant as f32 * HALF_PI;
    let sine = poly_sin(remainder);
    let cosine = poly_cos(remainder);
    match quadrant & 3 {
        0 => (sine, cosine),
        1 => (cosine, -sine),
        2 => (-sine, -cosine),
        _ => (-cosine, sine),
    }
}

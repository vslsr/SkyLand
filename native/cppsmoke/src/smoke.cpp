/**
 * SkyLand 的 C++ → WebAssembly 工具链冒烟件。
 *
 * 它刻意不做任何真实工作。存在的唯一目的，是让「em++ 编得出 → 产物零 import →
 * Node 与浏览器都能实例化并调用」这条链路有一个能持续运行的断言，
 * 而不是等到写真正的引擎代码时才发现某一环没通。
 *
 * doc/engine-migration-roadmap.html 规划的 C++ 渲染器核心会沿用同一条链路，
 * 所以这里先把它钉住：以后链路断了，是这个 3 行的文件先红，而不是渲染器。
 */

#include <emscripten/emscripten.h>

extern "C" {

/**
 * 冒烟契约版本。改动下面任何一个导出的签名时 +1，
 * JS 侧据此拒绝陈旧产物（与 chunkgen 校验 template_count 的用意一致）。
 */
EMSCRIPTEN_KEEPALIVE int smoke_abi_version(void) { return 1; }

/** 冒烟用的唯一计算导出。 */
EMSCRIPTEN_KEEPALIVE int add(int a, int b) { return a + b; }

}

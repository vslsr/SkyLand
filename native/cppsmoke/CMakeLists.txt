# 只在 Emscripten 工具链下构建：用 npm run build:cpp-wasm 驱动，
# 它会先套上 emcmake（见 scripts/build-cpp-wasm.mjs）。
cmake_minimum_required(VERSION 3.20)
project(cppsmoke CXX)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "cppsmoke 只面向 wasm，请用 npm run build:cpp-wasm 构建")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# 产物直接叫 .wasm：STANDALONE_WASM 下不再生成 JS 胶水，
# 调用方与 chunkgen.wasm 一样用 WebAssembly.instantiate(bytes, {}) 拿到实例。
set(CMAKE_EXECUTABLE_SUFFIX ".wasm")

add_executable(cppsmoke src/smoke.cpp)

target_link_options(cppsmoke PRIVATE
  # --no-entry：没有 main，模块是一组纯函数导出而不是一个程序。
  "--no-entry"
  # STANDALONE_WASM：不产 JS 胶水，产物是自包含的 wasm。
  "-sSTANDALONE_WASM=1"
  # 关掉 JS 侧运行时的一切假设，确保 import 段为空。
  "-sALLOW_MEMORY_GROWTH=0"
  "-sASSERTIONS=0"
)

cmake_minimum_required(VERSION 3.16)
project(Ch2)

# 1. 基础配置
set(MLIR_DIR "/mnt/data/build/llvm-build/lib/cmake/mlir")
set(LLVM_DIR "/mnt/data/build/llvm-build/lib/cmake/llvm")

find_package(MLIR REQUIRED CONFIG)
find_package(LLVM REQUIRED CONFIG)

list(APPEND CMAKE_MODULE_PATH "${MLIR_CMAKE_DIR}")
list(APPEND CMAKE_MODULE_PATH "${LLVM_CMAKE_DIR}")

include(AddLLVM)
include(AddMLIR)
include(TableGen)

add_subdirectory(my_dialect)

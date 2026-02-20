# my_dialect: MLIR add dialect project
set(MLIR_DIR "/mnt/data/build/llvm-build/lib/cmake/mlir")
set(LLVM_DIR "/mnt/data/build/llvm-build/lib/cmake/llvm")

find_package(MLIR REQUIRED CONFIG)
find_package(LLVM REQUIRED CONFIG)

list(APPEND CMAKE_MODULE_PATH "${MLIR_CMAKE_DIR}")
list(APPEND CMAKE_MODULE_PATH "${LLVM_CMAKE_DIR}")

include(AddLLVM)
include(AddMLIR)
include(TableGen)

include_directories(
  ${MLIR_INCLUDE_DIRS}
  ${LLVM_INCLUDE_DIRS}
  ${CMAKE_CURRENT_SOURCE_DIR}/include
  ${CMAKE_CURRENT_BINARY_DIR}/include
)
include_directories(${CMAKE_CURRENT_SOURCE_DIR}/include)
include_directories(${CMAKE_CURRENT_BINARY_DIR}/include)

add_subdirectory(include)
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fno-rtti -fno-exceptions -g -O0 -std=c++17")

add_executable(dialect_my
  my_add.cpp)

add_dependencies(dialect_my
  AddOpsIncGen)

target_link_libraries(dialect_my
  PRIVATE
  MLIRIR
  MLIRParser
  MLIRPass
  MLIRSupport
  MLIRTransforms
  MLIRAnalysis
  MLIRLLVMCommonConversion
  LLVMCore
  LLVMSupport
  MLIRArithDialect)

# my_dialect: MLIR add dialect project
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

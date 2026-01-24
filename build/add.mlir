
// 导入所需dialect（显式导入避免依赖隐式加载）
builtin.module attributes {
  // 将target信息作为module属性（兼容所有MLIR版本）
  llvm.data_layout = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i64:64-f80:128-n8:16:32:64-S128",
  llvm.target_triple = "x86_64-unknown-linux-gnu"
} {
  // 加法核心函数：接收两个i64整数，返回相加结果
  func.func @add(%a: i64, %b: i64) -> i64 {
    %sum = arith.addi %a, %b : i64
    return %sum : i64
  }

  // 主函数：处理命令行参数、调用加法函数、输出结果
  func.func @main() -> i32 {
    // 1. 获取命令行参数个数
    %argc = llvm.mlir.constant(0 : i32) : i32
    %argv = llvm.mlir.constant(0 : i64) : i64
    llvm.call @llvm.stdin.getargs(%argc, %argv) : (i32, i64) -> ()
    %argc_val = llvm.load %argc : !llvm.ptr<i32>
    %expected_argc = llvm.mlir.constant(3 : i32) : i32
    
    // 检查参数个数是否为3（程序名+两个数字）
    %argc_ok = arith.cmpi eq, %argc_val, %expected_argc : i32
    cond_br %argc_ok, ^bb1, ^bb_error

  ^bb1:  // 参数个数正确，解析第一个数字
    %argv_ptr = llvm.load %argv : !llvm.ptr<i64>
    %arg1_ptr = llvm.getelementptr %argv_ptr[1] : !llvm.ptr<i64> -> !llvm.ptr<i64>
    %arg1 = llvm.load %arg1_ptr : !llvm.ptr<i64>
    %num1 = llvm.call @llvm.atoi(%arg1) : (!llvm.ptr<i8>) -> i32
    %num1_i64 = arith.extsi %num1 : i32 to i64

    // 解析第二个数字
    %arg2_ptr = llvm.getelementptr %argv_ptr[2] : !llvm.ptr<i64> -> !llvm.ptr<i64>
    %arg2 = llvm.load %arg2_ptr : !llvm.ptr<i64>
    %num2 = llvm.call @llvm.atoi(%arg2) : (!llvm.ptr<i8>) -> i32
    %num2_i64 = arith.extsi %num2 : i32 to i64

    // 调用加法函数
    %sum = func.call @add(%num1_i64, %num2_i64) : (i64, i64) -> i64

    // 输出结果
    %format_str = llvm.mlir.constant "Sum: %lld\n" : !llvm.ptr<i8>
    llvm.call @printf(%format_str, %sum) : (!llvm.ptr<i8>, i64) -> i32
    br ^bb_exit

  ^bb_error:  // 参数个数错误，输出提示
    %error_str = llvm.mlir.constant "Usage: ./adder <num1> <num2>\n" : !llvm.ptr<i8>
    llvm.call @printf(%error_str) : (!llvm.ptr<i8>) -> i32
    %error_code = llvm.mlir.constant(1 : i32) : i32
    return %error_code : i32

  ^bb_exit:  // 正常退出
    %zero = llvm.mlir.constant(0 : i32) : i32
    return %zero : i32
  }

  // 声明外部函数（C标准库）
  llvm.func @llvm.stdin.getargs(i32, i64) -> ()
  llvm.func @llvm.atoi(!llvm.ptr<i8>) -> i32
  llvm.func @printf(!llvm.ptr<i8>, ...) -> i32
}



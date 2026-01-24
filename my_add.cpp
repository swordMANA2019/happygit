#include "add/Dialect.h"
#include "mlir/IR/Builders.h"
#include "mlir/IR/BuiltinOps.h"
#include "mlir/IR/MLIRContext.h"
#include "mlir/IR/Location.h"
#include "mlir/IR/Types.h"
#include "mlir/Dialect/Arith/IR/Arith.h"

using namespace ::mlir::my_add;

#include "add/Dialect.cpp.inc"


/// Dialect initialization, the instance will be owned by the context. This is
/// the point of registration of types and operations for the dialect.
void AddDialect::initialize() {
  addOperations<
#define GET_OP_LIST
#include "add/Ops.cpp.inc"
      >();
}

#define GET_OP_CLASSES
#include "add/Ops.cpp.inc"

#define GET_OP_BUILDERS
#include "add/Ops.cpp.inc"

void AddOp::build(mlir::OpBuilder &builder, mlir::OperationState &state,
                  mlir::Value lhs, mlir::Value rhs) {
//   state.addTypes(UnrankedTensorType::get(builder.getF64Type()));
  state.addTypes(builder.getF32Type());
  state.addOperands({lhs, rhs});
}

int main() {
    mlir::MLIRContext context;
    context.getOrLoadDialect<AddDialect>();
    context.loadDialect<mlir::arith::ArithDialect>();
    mlir::OpBuilder builder(&context);
    mlir::Location loc = builder.getUnknownLoc();

    // Create a module and set insertion point to its body block.
    // Ops must live in a block for SSA values to print correctly; otherwise
    // operands show as <<UNKNOWN SSA VALUE>>.
    mlir::OwningOpRef<mlir::ModuleOp> module = mlir::ModuleOp::create(loc);
    builder.setInsertionPointToStart(module->getBody());

    // Create operands for the add operation.
    mlir::Type type = builder.getF32Type();
    mlir::Value lhs = builder.create<mlir::arith::ConstantOp>(
    loc, // Location (for error reporting)
    type,              // The constant value (as Attribute)
    builder.getF32FloatAttr(3.0));
    mlir::Value rhs = builder.create<mlir::arith::ConstantOp>(loc, type,
                                                         builder.getF32FloatAttr(4.0));
    
    // Create the add operation.
    AddOp addOp = builder.create<AddOp>(loc, lhs, rhs);
    
    // For demonstration purposes, print the result of the add operation.
    addOp.print(llvm::outs());
    llvm::outs() << "\n";
    
    return 0;

}
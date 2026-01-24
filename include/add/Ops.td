
//include "mlir/IR/BuiltinTypes.td"
include "mlir/IR/OpBase.td"



//metadata
def AddDialect:Dialect {

    let name = "add";
    let cppNamespace="::mlir::my_add";
}

//operation
def AddOp:Op<AddDialect,"add"> {

    let summary = "Add two values";
    let description = [{
        Computes the sum of two operands of the same type and returns one result.
    }];
    let arguments = (ins AnyFloat:$lhs, AnyFloat:$rhs);
    let results = (outs AnyFloat:$result);
    // Allow building an AddOp with from the two input operands.
    let builders = [
        OpBuilder<(ins "Value":$lhs, "Value":$rhs)>
    ];
}
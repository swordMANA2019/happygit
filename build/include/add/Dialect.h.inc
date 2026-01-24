/*===- TableGen'erated file -------------------------------------*- C++ -*-===*\
|*                                                                            *|
|* Dialect Declarations                                                       *|
|*                                                                            *|
|* Automatically generated file, do not edit!                                 *|
|* From: Ops.td                                                               *|
|*                                                                            *|
\*===----------------------------------------------------------------------===*/

namespace mlir {
namespace my_add {

class AddDialect : public ::mlir::Dialect {
  explicit AddDialect(::mlir::MLIRContext *context);

  void initialize();
  friend class ::mlir::MLIRContext;
public:
  ~AddDialect() override;
  static constexpr ::llvm::StringLiteral getDialectNamespace() {
    return ::llvm::StringLiteral("add");
  }
};
} // namespace my_add
} // namespace mlir
MLIR_DECLARE_EXPLICIT_TYPE_ID(::mlir::my_add::AddDialect)

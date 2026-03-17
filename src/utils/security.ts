import { OperationType, SecurityManager } from '../security/security-manager.js';

export function assertOperationAllowed(
  securityManager: SecurityManager,
  operation: OperationType
): void {
  if (!securityManager.isOperationAllowed(operation)) {
    throw new Error(
      `当前安全模式（${securityManager.getMode()}）不允许执行 ${operation} 操作。\n` +
      `允许的操作：${securityManager.getModeDescription()}`
    );
  }
}

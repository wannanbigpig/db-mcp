import { SecurityManager, SecurityMode } from '../security/security-manager.js';
import { buildSuccessResponse } from '../utils/response.js';
import { assertString } from '../utils/validation.js';

export class SecurityHandler {
  private securityManager: SecurityManager;

  constructor(securityManager: SecurityManager) {
    this.securityManager = securityManager;
  }

  handleSetMode(args: Record<string, unknown>) {
    const securityMode = assertString(args.mode, 'mode') as SecurityMode;
    
    if (!Object.values(SecurityMode).includes(securityMode)) {
      throw new Error(`无效的安全模式: ${securityMode}。有效值: read_only, restricted, full_access`);
    }
    
    this.securityManager.setMode(securityMode);
    return buildSuccessResponse(`安全模式已设置为: ${securityMode}\n${this.securityManager.getModeDescription()}`);
  }

  handleGetMode() {
    return buildSuccessResponse(`当前安全模式: ${this.securityManager.getMode()}\n${this.securityManager.getModeDescription()}`);
  }
}

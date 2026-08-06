import type { HostRole } from './contracts.js';

export type Capability =
  | 'operate'
  | 'configure'
  | 'manage-hosts'
  | 'change-venue'
  | 'void-bill';

export function can(role: HostRole, capability: Capability): boolean {
  if (capability === 'operate') return true;
  return role === 'admin';
}

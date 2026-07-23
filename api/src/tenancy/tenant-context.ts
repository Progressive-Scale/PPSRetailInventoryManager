import { Company } from '../db/schema';

export type HostContext =
  | { kind: 'company'; company: Company }
  | { kind: 'admin' }
  | { kind: 'unknown' };

/** Express request augmented with the resolved tenant. */
export interface RequestWithTenant {
  tenant?: HostContext;
  headers: Record<string, string | string[] | undefined>;
}

import type { ComponentType, SVGProps } from 'react';
import {
  IconAgents,
  IconApprovals,
  IconCosts,
  IconExecutions,
  IconObservability,
  IconOverview,
  IconPolicies,
  IconSchedules,
  IconSettings,
  IconTasks,
  IconTools,
} from './icons';

export interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

/**
 * Shared by the server-rendered layout (for the command palette) and the client
 * sidebar. It lives outside the `'use client'` boundary because only components
 * cross that boundary — a plain array exported from a client module is not
 * importable by a server component.
 */
export const NAV: NavItem[] = [
  { href: '/', label: 'Overview', icon: IconOverview },
  { href: '/agents', label: 'Agents', icon: IconAgents },
  { href: '/executions', label: 'Executions', icon: IconExecutions },
  { href: '/approvals', label: 'Approvals', icon: IconApprovals },
  { href: '/tasks', label: 'Tasks', icon: IconTasks },
  { href: '/tools', label: 'Tools', icon: IconTools },
  { href: '/schedules', label: 'Schedules', icon: IconSchedules },
  { href: '/policies', label: 'Policies', icon: IconPolicies },
  { href: '/costs', label: 'Costs', icon: IconCosts },
  { href: '/observability', label: 'Observability', icon: IconObservability },
  { href: '/settings', label: 'Settings', icon: IconSettings },
];

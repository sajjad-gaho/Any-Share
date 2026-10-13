import { BRAND } from '@remote-desktop/shared';
import { LogoMark, Tooltip, cn } from '@remote-desktop/ui';
import {
  ArrowLeftRight,
  BookUser,
  CircleUser,
  History,
  LayoutDashboard,
  Monitor,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { NavLink } from 'react-router';
import { ThemeMenu } from '@/components/ThemeMenu';
import { useAppInfo } from '@/lib/desktop-api';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

const PRIMARY_NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/devices', label: 'Devices', icon: Monitor },
  { to: '/sessions', label: 'Sessions', icon: History },
  { to: '/transfers', label: 'Transfers', icon: ArrowLeftRight },
  { to: '/address-book', label: 'Address Book', icon: BookUser },
  { to: '/team', label: 'Team', icon: Users },
];

const SECONDARY_NAV: NavItem[] = [
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/account', label: 'Account', icon: CircleUser },
];

function SidebarLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <li>
      {/* Tooltip only matters when labels are hidden (narrow windows). The tooltip trigger
          merges className as a string, so active styling keys off NavLink's aria-current. */}
      <Tooltip content={item.label} side="right">
        <NavLink
          to={item.to}
          end={item.end}
          className={cn(
            'flex h-9 items-center gap-3 rounded-md px-2.5 text-sm font-medium transition-colors',
            'justify-center lg:justify-start',
            'text-sidebar-foreground hover:bg-sidebar-accent/60',
            'aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground',
          )}
        >
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          <span className="sr-only lg:not-sr-only">{item.label}</span>
        </NavLink>
      </Tooltip>
    </li>
  );
}

export function Sidebar() {
  const appInfo = useAppInfo();

  return (
    <aside className="flex w-16 shrink-0 flex-col border-r bg-sidebar lg:w-60">
      <div className="flex h-14 items-center gap-2.5 px-4">
        <LogoMark className="size-7" />
        <div className="hidden leading-tight lg:block">
          <p className="text-sm font-semibold">{BRAND.productName}</p>
          <p className="text-[11px] text-muted-foreground">{BRAND.tagline}</p>
        </div>
      </div>

      <nav aria-label="Main" className="flex flex-1 flex-col justify-between px-3 py-2">
        <ul className="space-y-1">
          {PRIMARY_NAV.map((item) => (
            <SidebarLink key={item.to} item={item} />
          ))}
        </ul>
        <ul className="space-y-1">
          {SECONDARY_NAV.map((item) => (
            <SidebarLink key={item.to} item={item} />
          ))}
        </ul>
      </nav>

      <div className="space-y-1 border-t p-3">
        <div className="hidden lg:block">
          <ThemeMenu />
        </div>
        <div className="flex justify-center lg:hidden">
          <ThemeMenu compact />
        </div>
        <p className="hidden px-2.5 text-[11px] text-muted-foreground lg:block">
          {appInfo ? `Version ${appInfo.version}` : ' '}
        </p>
      </div>
    </aside>
  );
}

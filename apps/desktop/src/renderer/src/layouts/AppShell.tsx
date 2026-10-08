import { Outlet } from 'react-router';
import { Sidebar } from './Sidebar';

export function AppShell() {
  return (
    <div className="flex h-full">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <Sidebar />
      <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto outline-none">
        <div className="mx-auto w-full max-w-6xl space-y-6 px-6 py-8 lg:px-10">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

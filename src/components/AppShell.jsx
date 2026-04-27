import { useState, useEffect } from 'react';
import Header from './Header.jsx';

// AppShell — top header + (optional) left sidebar + main content grid.
//
// Each tool component renders its own `<aside class="tool-sidebar">` and
// `<main class="tool-main">` as siblings inside this shell. The grid in
// index.css turns those into the two columns. Routes that opt out of
// the sidebar (currently just About) get full-width by passing
// `withSidebar={false}` so the shell drops the sidebar grid track.
//
// Mobile: at <1024px the sidebar absolute-positions itself and slides in
// when `data-sidebar-open="true"`. The hamburger in Header toggles it.
export default function AppShell({ route, withSidebar = true, children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Close the drawer on route change so navigating to a new tool from
  // the top nav doesn't leave the previous tool's filters covering the
  // page on mobile.
  useEffect(() => { setSidebarOpen(false); }, [route?.name, route?.year, route?.gameKey]);

  const shellClass = `app-shell${withSidebar ? '' : ' no-sidebar'}`;
  const dataAttr = sidebarOpen ? { 'data-sidebar-open': 'true' } : {};

  return (
    <>
      <Header
        route={route}
        showHamburger={withSidebar}
        onToggleSidebar={() => setSidebarOpen(o => !o)}
      />
      <div className={shellClass} {...dataAttr}>
        {children}
        {withSidebar && sidebarOpen && (
          <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
        )}
      </div>
    </>
  );
}

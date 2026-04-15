import { NavLink } from 'react-router-dom';

const NAV_ITEMS = [
  { to: '/games',   label: 'GAME LOOKUP' },
  { to: '/season',  label: 'SEASON BROWSER' },
  { to: '/players', label: 'PLAYER BROWSER' },
  { to: '/teams',   label: 'TEAM BROWSER' },
  { to: '/about',   label: 'METHODOLOGY' },
];

export default function Header() {
  return (
    <header className="app-header">
      <div className="logo">
        <div className="logo-pip" />
        Volleyball GIS
      </div>
      <nav className="nav-pills">
        {NAV_ITEMS.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `nav-pill${isActive ? ' active' : ''}`}
          >
            {label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}

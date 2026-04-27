import { hrefFor, useLinkHandler } from '../lib/router.js';

export default function Header({ route, showHamburger = false, onToggleSidebar }) {
  const onClick = useLinkHandler();
  const active  = route?.name || 'about';

  const tab = (id, label) => (
    <a
      key={id}
      href={hrefFor(id)}
      onClick={onClick}
      className={`nav-pill${active === id ? ' active' : ''}`}
    >
      {label}
    </a>
  );

  return (
    <header className="app-header">
      <div className="app-header-left">
        {showHamburger && (
          <button
            type="button"
            className="sidebar-toggle"
            onClick={onToggleSidebar}
            aria-label="Toggle filters"
          >
            ☰
          </button>
        )}
        <a href={hrefFor('about')} onClick={onClick} className="logo">
          <div className="logo-pip" />
          Volleyball GIS
        </a>
      </div>
      <nav className="nav-pills">
        {tab('about',   'About')}
        {tab('games',   'Games')}
        {tab('players', 'Players')}
        {tab('seasons', 'Seasons')}
        {tab('teams',   'Teams')}
      </nav>
    </header>
  );
}

import { hrefFor, useLinkHandler } from '../lib/router.js';

export default function Header({ route }) {
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
      <a href={hrefFor('about')} onClick={onClick} className="logo">
        <div className="logo-pip" />
        Volleyball GIS
      </a>
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

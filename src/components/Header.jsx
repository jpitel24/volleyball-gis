export default function Header({ view = 'games', onChangeView }) {
  const tab = (id, label) => (
    <button
      type="button"
      className={`nav-pill${view === id ? ' active' : ''}`}
      onClick={() => onChangeView && onChangeView(id)}
    >
      {label}
    </button>
  );
  return (
    <header className="app-header">
      <div className="logo">
        <div className="logo-pip" />
        Volleyball GIS
      </div>
      {onChangeView && (
        <nav className="nav-pills">
          {tab('games',   'Games')}
          {tab('players', 'Players')}
          {tab('seasons', 'Seasons')}
        </nav>
      )}
    </header>
  );
}

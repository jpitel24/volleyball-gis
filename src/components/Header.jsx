export default function Header({ activeTab, setActiveTab }) {
  return (
    <header className="app-header">
      <div className="logo">
        <div className="logo-pip" />
        Volleyball GIS
      </div>
      <nav className="nav-pills">
        <button
          className={`nav-pill ${activeTab === 'game' ? 'active' : ''}`}
          onClick={() => setActiveTab('game')}
        >
          GAME LOOKUP
        </button>
        <button
          className={`nav-pill ${activeTab === 'season' ? 'active' : ''}`}
          onClick={() => setActiveTab('season')}
        >
          SEASON BROWSER
        </button>
        <button
          className={`nav-pill ${activeTab === 'player' ? 'active' : ''}`}
          onClick={() => setActiveTab('player')}
        >
          PLAYER BROWSER
        </button>
        <button
          className={`nav-pill ${activeTab === 'team' ? 'active' : ''}`}
          onClick={() => setActiveTab('team')}
        >
          TEAM BROWSER
        </button>
      </nav>
    </header>
  );
}

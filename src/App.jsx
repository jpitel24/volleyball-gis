import { useState } from 'react';
import { DataProvider } from './lib/DataContext.jsx';
import Header from './components/Header.jsx';
import GameLookup from './components/GameLookup.jsx';
import PlayerLookup from './components/PlayerLookup.jsx';

export default function App() {
  const [view, setView]         = useState('games');   // 'games' | 'players'
  const [deepLink, setDeepLink] = useState(null);      // { year, gameKey } | null

  function handleGameDeepLink(year, gameKey) {
    setDeepLink({ year, gameKey });
    setView('games');
  }

  return (
    <DataProvider>
      <Header view={view} onChangeView={setView} />
      {view === 'games'
        ? <GameLookup deepLink={deepLink} onDeepLinkConsumed={() => setDeepLink(null)} />
        : <PlayerLookup onGameDeepLink={handleGameDeepLink} />
      }
    </DataProvider>
  );
}

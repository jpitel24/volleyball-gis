import { useState } from 'react';
import { DataProvider } from './lib/DataContext.jsx';
import Header from './components/Header.jsx';
import GameLookup from './components/GameLookup.jsx';
import SeasonBrowser from './components/SeasonBrowser.jsx';
import PlayerBrowser from './components/PlayerBrowser.jsx';
import TeamBrowser from './components/TeamBrowser.jsx';

export default function App() {
  const [activeTab, setActiveTab] = useState('game');

  return (
    <DataProvider>
      <Header activeTab={activeTab} setActiveTab={setActiveTab} />
      {activeTab === 'game'   && <GameLookup />}
      {activeTab === 'season' && <SeasonBrowser />}
      {activeTab === 'player' && <PlayerBrowser />}
      {activeTab === 'team'   && <TeamBrowser />}
    </DataProvider>
  );
}

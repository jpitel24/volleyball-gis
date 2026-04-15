import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { DataProvider } from './lib/DataContext.jsx';
import Header from './components/Header.jsx';
import GameLookup from './components/GameLookup.jsx';
import SeasonBrowser from './components/SeasonBrowser.jsx';
import PlayerBrowser from './components/PlayerBrowser.jsx';
import TeamBrowser from './components/TeamBrowser.jsx';
import About from './components/About.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <DataProvider>
        <Header />
        <Routes>
          <Route path="/"        element={<Navigate to="/season" replace />} />
          <Route path="/season"  element={<SeasonBrowser />} />
          <Route path="/players" element={<PlayerBrowser />} />
          <Route path="/teams"   element={<TeamBrowser />} />
          <Route path="/games"   element={<GameLookup />} />
          <Route path="/about"   element={<About />} />
          <Route path="*"        element={<Navigate to="/season" replace />} />
        </Routes>
      </DataProvider>
    </BrowserRouter>
  );
}

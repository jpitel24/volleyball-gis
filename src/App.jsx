import { DataProvider } from './lib/DataContext.jsx';
import Header from './components/Header.jsx';
import About from './components/About.jsx';
import GameLookup from './components/GameLookup.jsx';
import PlayerLookup from './components/PlayerLookup.jsx';
import SeasonLookup from './components/SeasonLookup.jsx';
import TeamLookup from './components/TeamLookup.jsx';
import { useRoute, navigate, hrefFor } from './lib/router.js';

export default function App() {
  const route = useRoute();   // { name: 'about'|'games'|'players'|..., year?, gameKey? }

  // Player Browser → Game Browser deep-link: navigate to the canonical
  // /games/:year/:key URL. GameLookup will read it from the route on
  // mount and select the match itself.
  function handleGameDeepLink(year, gameKey) {
    navigate(hrefFor('games', year, gameKey));
  }

  return (
    <DataProvider>
      <Header route={route} />
      {route.name === 'about'   && <About />}
      {route.name === 'games'   && <GameLookup route={route} />}
      {route.name === 'players' && <PlayerLookup onGameDeepLink={handleGameDeepLink} />}
      {route.name === 'seasons' && <SeasonLookup />}
      {route.name === 'teams'   && <TeamLookup />}
    </DataProvider>
  );
}

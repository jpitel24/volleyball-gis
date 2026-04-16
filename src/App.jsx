import { DataProvider } from './lib/DataContext.jsx';
import Header from './components/Header.jsx';
import GameLookup from './components/GameLookup.jsx';

export default function App() {
  return (
    <DataProvider>
      <Header />
      <GameLookup />
    </DataProvider>
  );
}

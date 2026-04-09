import { createContext, useContext, useEffect, useState } from 'react';

const DataContext = createContext(null);

export function DataProvider({ children }) {
  const [data, setData] = useState({
    pgisTables:  null,
    rpiByYear:   null,
    playerArchive: null,
    gameLogs:    null,
    loading:     true,
    error:       null,
  });

  useEffect(() => {
    async function load() {
      try {
        const [pgisTables, rpiByYear, playerArchive, gameLogs] = await Promise.all([
          fetch('/data/pgis_tables.json').then(r => r.json()),
          fetch('/data/rpi_by_year.json').then(r => r.json()),
          fetch('/data/player_archive.json').then(r => r.json()),
          fetch('/data/game_logs.json').then(r => r.json()),
        ]);
        setData({ pgisTables, rpiByYear, playerArchive, gameLogs, loading: false, error: null });
      } catch (e) {
        setData(d => ({ ...d, loading: false, error: e.message }));
      }
    }
    load();
  }, []);

  return <DataContext.Provider value={data}>{children}</DataContext.Provider>;
}

export function useData() {
  return useContext(DataContext);
}

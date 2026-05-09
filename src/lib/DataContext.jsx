import { createContext, useContext, useEffect, useState } from 'react';

const DataContext = createContext(null);

export function DataProvider({ children }) {
  const [data, setData] = useState({
    pgisTables:         null,
    rpiByYear:          null,
    categoryPgisTables: null,
    receptionQuality:   null,   // { "<player_key>|<school_key>|<year>": { ... } }
    serveQuality:       null,   // ditto, parallel shape
    loading:            true,
    error:              null,
  });

  useEffect(() => {
    async function load() {
      try {
        const safeJson = r => r.ok ? r.json().catch(() => null) : null;
        const [
          pgisTables, rpiByYear, categoryPgisTables,
          receptionQuality, serveQuality,
        ] = await Promise.all([
          fetch('/data/pgis_tables.json').then(safeJson),
          fetch('/data/historical_rpi.json').then(safeJson),
          fetch('/data/category_pgis_tables.json').then(safeJson),
          fetch('/data/wvb_reception_quality_2025.json').then(safeJson),
          fetch('/data/wvb_serve_quality_2025.json').then(safeJson),
        ]);
        setData({
          pgisTables, rpiByYear, categoryPgisTables,
          receptionQuality, serveQuality,
          loading: false, error: null,
        });
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

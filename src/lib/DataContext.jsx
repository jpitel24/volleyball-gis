import { createContext, useContext, useEffect, useState } from 'react';

const DataContext = createContext(null);

export function DataProvider({ children }) {
  const [data, setData] = useState({
    pgisTables:         null,
    rpiByYear:          null,
    categoryPgisTables: null,
    receptionQuality:   null,   // { "<player_key>|<school_key>|<year>": { ... } }
    serveQuality:       null,
    setQuality:         null,
    loading:            true,
    error:              null,
  });

  useEffect(() => {
    async function load() {
      try {
        const safeJson = r => r.ok ? r.json().catch(() => null) : null;

        // Per-year quality JSONs are keyed by '<player>|<school>|<year>'
        // so merging across years stays unique. Years that haven't been
        // backfilled yet 404 → null → silently skipped.
        async function loadAcrossYears(template) {
          const years = [2022, 2023, 2024, 2025];
          const results = await Promise.all(
            years.map(y => fetch(template.replace('{year}', y)).then(safeJson))
          );
          const merged = {};
          for (const r of results) if (r) Object.assign(merged, r);
          return Object.keys(merged).length > 0 ? merged : null;
        }

        const [
          pgisTables, rpiByYear, categoryPgisTables,
          receptionQuality, serveQuality, setQuality,
        ] = await Promise.all([
          fetch('/data/pgis_tables.json').then(safeJson),
          fetch('/data/historical_rpi.json').then(safeJson),
          fetch('/data/category_pgis_tables.json').then(safeJson),
          loadAcrossYears('/data/wvb_reception_quality_{year}.json'),
          loadAcrossYears('/data/wvb_serve_quality_{year}.json'),
          loadAcrossYears('/data/wvb_set_quality_{year}.json'),
        ]);
        setData({
          pgisTables, rpiByYear, categoryPgisTables,
          receptionQuality, serveQuality, setQuality,
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

import { createContext, useContext, useEffect, useState } from 'react';

const DataContext = createContext(null);

export function DataProvider({ children }) {
  const [data, setData] = useState({
    pgisTables:         null,
    rpiByYear:          null,
    categoryPgisTables: null,
    loading:            true,
    error:              null,
  });

  useEffect(() => {
    async function load() {
      try {
        const safeJson = r => r.ok ? r.json().catch(() => null) : null;
        const [pgisTables, rpiByYear, categoryPgisTables] = await Promise.all([
          fetch('/data/pgis_tables.json').then(safeJson),
          fetch('/data/rpi_by_year.json').then(safeJson),
          fetch('/data/category_pgis_tables.json').then(safeJson),
        ]);
        setData({ pgisTables, rpiByYear, categoryPgisTables, loading: false, error: null });
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

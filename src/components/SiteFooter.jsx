import { useEffect, useState } from 'react';
import { loadGisPlus, getLatestObservationDate } from '../lib/gisPlus.js';

// SiteFooter — small footer strip pinned below every page. Shows two
// freshness indicators so users can tell whether they're looking at
// current data or a stale build:
//
//   Data through <date>   — newest match observation in the shipped CSV
//                           (means "actual games captured up to this day")
//   Site built <date>     — when the JS bundle was compiled (from Vite's
//                           __BUILD_DATE__ define; changes on every deploy)
//
// The build date always renders (it's synchronous). The data date renders
// once loadGisPlus resolves, otherwise shows a placeholder — DataContext
// kicks off the load early enough that this is usually milliseconds.

const BUILD_DATE_ISO = typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : null;
const BUILD_DATE = BUILD_DATE_ISO
  ? new Date(BUILD_DATE_ISO).toLocaleDateString('en-US',
      { year: 'numeric', month: 'short', day: 'numeric' })
  : 'unknown';

function formatMatchDate(iso) {
  if (!iso) return null;
  // Parse as local date to avoid off-by-one from UTC interpretation.
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-US',
    { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function SiteFooter() {
  const [dataDate, setDataDate] = useState(getLatestObservationDate());

  useEffect(() => {
    let cancelled = false;
    loadGisPlus().then(() => {
      if (!cancelled) setDataDate(getLatestObservationDate());
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <footer className="site-footer" role="contentinfo">
      <span>
        Data through{' '}
        <strong>{dataDate ? formatMatchDate(dataDate) : '…'}</strong>
      </span>
      <span className="site-footer-sep">·</span>
      <span>
        Site built <strong>{BUILD_DATE}</strong>
      </span>
    </footer>
  );
}

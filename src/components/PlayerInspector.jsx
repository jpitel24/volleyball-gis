import { createPortal } from 'react-dom';
import { useEffect } from 'react';
import { gisTier, pgisLabel, posColor, computeCategoryGIS, computePGIS } from '../lib/gis.js';

// Right-side inspection panel. Replaces the old centered modal — the
// player's full breakdown (category contributions, raw stat line,
// leverage notes) lives here while the slim card on the page just
// surfaces GIS / GIS+ / pGIS + pill stats.
//
// Behavior: fixed-position overlay anchored to the right edge of the
// viewport, below the sticky 56px header. No backdrop — clicking
// elsewhere on the report (including another player card) doesn't
// close it; instead, swapping cards updates `p`. Close via the X
// button or pressing Escape.
export default function PlayerInspector({ p, onClose, nSets, categoryPgisTables }) {
  // Wire ESC → close so the panel feels keyboard-native.
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Categories come back from computeCategoryGIS as per-SET rates (vol = raw / ns).
  // The displayed headline p.gis / p.gisPlus is per-MATCH (Python overlay value).
  // Rescale each category proportionally so its row sums to the headline,
  // preserving relative shape while keeping the math additive in the
  // user's eyes. p.pGIS is per-position percentile and unaffected.
  // c.gisNeutral is left at per-set so the per-category pGIS lookup
  // against `categoryPgisTables` (built on per-set baselines) stays valid.
  const rawCats   = computeCategoryGIS(p, p.ns, p.avgLev, p.oppMod).filter(c => c.gis > 0);
  const sumGis     = rawCats.reduce((s, c) => s + c.gis,     0) || 1;
  const sumGisPlus = rawCats.reduce((s, c) => s + c.gisPlus, 0) || 1;
  const gScale     = (p.gis     || 0) / sumGis;
  const gpScale    = (p.gisPlus || 0) / sumGisPlus;
  const cats = rawCats.map(c => ({
    ...c,
    gis:     c.gis     * gScale,
    gisPlus: c.gisPlus * gpScale,
    pGIS: categoryPgisTables
      ? computePGIS(c.gisNeutral, p.position, nSets, categoryPgisTables[c.key])
      : null,
  }));
  const maxGis = Math.max(...cats.map(c => c.gis), 0.01);

  const [, tc]         = gisTier(p.gis);
  const pc             = posColor(p.position);
  const [pLabel, pCls] = pgisLabel(p.pGIS);

  return createPortal(
    <aside className="inspector-panel" role="complementary" aria-label="Player detail">
      {/* Header: position badge + name + team + close */}
      <div className="inspector-hdr" style={{ borderLeft: `3px solid ${pc}` }}>
        <div className="inspector-hdr-left">
          <span className="pos-badge" style={{ background: `${pc}20`, color: pc, borderColor: `${pc}40` }}>
            {p.position}
          </span>
          <div className="inspector-name-block">
            <div className="inspector-name">{p.name}</div>
            <div className="inspector-team">{p.team}</div>
          </div>
        </div>
        <button className="inspector-close" onClick={onClose} aria-label="Close inspector">✕</button>
      </div>

      {/* Overall scores */}
      <div className="inspector-scores">
        <div className="modal-score-block">
          <span className="modal-score-num" style={{ color: tc }}>{p.gis.toFixed(2)}</span>
          <span className="score-lbl">GIS</span>
        </div>
        <div className="score-divider" />
        <div className="modal-score-block">
          <span className="modal-score-num" style={{ color: 'var(--gisplus)' }}>{p.gisPlus.toFixed(2)}</span>
          <span className="score-lbl">GIS+</span>
        </div>
        <div className="score-divider" />
        <div className="modal-score-block">
          <span className={`pgis-ctx ${pCls}`} style={{ marginBottom: '0.2rem' }}>{pLabel}</span>
          <span className="modal-score-num">{p.pGIS !== null ? p.pGIS.toFixed(2) : '—'}</span>
          <span className="score-lbl">pGIS</span>
        </div>
      </div>
      <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '0.58rem', color: 'var(--muted)', marginTop: '-0.4rem', letterSpacing: '0.04em' }}>
        Per-match values · category contributions sum to GIS.
      </div>

      {/* Category breakdown */}
      <div className="modal-section-lbl">BREAKDOWN BY CATEGORY</div>
      <div className="modal-cats">
        {cats.map(c => (
          <div key={c.key} className="modal-cat-row">
            <span className="modal-cat-label">{c.label}</span>
            <div className="modal-cat-bar-wrap">
              <div className="modal-cat-bar-track">
                <div
                  className="modal-cat-bar-fill"
                  style={{ width: `${Math.min((c.gis / maxGis) * 100, 100).toFixed(1)}%` }}
                />
              </div>
            </div>
            <span className="modal-cat-gis" style={{ color: tc }}>{c.gis.toFixed(2)}</span>
            <span className="modal-cat-gisplus">{c.gisPlus.toFixed(2)}</span>
            <span className="modal-cat-pgis">{c.pGIS !== null ? c.pGIS.toFixed(1) : '—'}</span>
            <span className="modal-cat-hdrs">GIS / GIS+ / pGIS</span>
          </div>
        ))}
        {cats.length === 0 && (
          <div style={{ color: 'var(--muted)', fontFamily: "'JetBrains Mono',monospace", fontSize: '0.7rem' }}>
            No contributing stats
          </div>
        )}
      </div>

      {/* Efficiency row */}
      {(() => {
        const ta    = p.total_attacks      || 0;
        const sva   = p.serve_attempts     || 0;
        const rca   = p.reception_attempts || 0;
        const sta   = p.set_attempts       || 0;
        if (ta + sva + rca + sta === 0) return null;
        const srvPct = sva > 0 ? ((p.service_aces || 0) - (p.service_errors || 0)) / sva : 0;
        const recPct = rca > 0 ? (rca - (p.reception_errors || 0)) / rca : 0;
        const setPct = sta > 0 ? ((p.assists || 0) - (p.set_errors || 0)) / sta : 0;
        const cell = (label, val, active) => (
          <div className={`stat-cell ${active ? '' : 'stat-cell-dim'}`}>
            <div className="stat-num">{active ? val.toFixed(3) : '—'}</div>
            <div className="stat-lbl">{label}</div>
          </div>
        );
        return (
          <>
            <div className="modal-section-lbl">EFFICIENCY</div>
            <div className="stat-eff-grid" style={{ borderBottom: 'none', paddingBottom: 0 }}>
              {cell('HIT%', p.hit_pct || 0, ta > 0)}
              {cell('SRV%', srvPct,         sva > 0)}
              {cell('REC%', recPct,         rca > 0)}
              {cell('SET%', setPct,         sta > 0)}
            </div>
          </>
        );
      })()}

      {/* Raw stats */}
      <div className="modal-section-lbl" style={{ marginTop: '0.5rem' }}>
        RAW STATS · {p.ns} SET{p.ns !== 1 ? 'S' : ''}
      </div>
      <div className="modal-raw-stats">
        {[
          ['K',    p.kills],
          ['E',    p.errors],
          ['TA',   p.total_attacks],
          ['HIT%', (p.hit_pct || 0).toFixed(3)],
          ['A',    p.assists],
          ['BHE',  p.ball_handling_errors],
          ['BS',   p.block_solos],
          ['BA',   p.block_assists],
          ['BE',   p.blocking_errors],
          ['D',    p.digs],
          ['RE',   p.reception_errors],
          ['Ace',  p.service_aces],
          ['SE',   p.service_errors],
        ].filter(([, v]) => v && v !== '0.000' && v !== 0).map(([lbl, v]) => (
          <div key={lbl} className="stat-cell">
            <div className="stat-num">{v}</div>
            <div className="stat-lbl">{lbl}</div>
          </div>
        ))}
      </div>

      {/* Leverage context */}
      <div className="modal-lev-note">
        Leverage: <strong>{p.avgLev.toFixed(3)}×</strong> avg ·{' '}
        {p.levPlays > 0
          ? `${p.levPlays} PBP plays · win-prob weighted`
          : 'match-level only (no PBP)'}
        {p.oppRank && ` · OPP RPI #${p.oppRank} (${p.oppMod >= 1 ? '+' : ''}${((p.oppMod - 1) * 100).toFixed(1)}%)`}
      </div>
    </aside>,
    document.body
  );
}

import { createPortal } from 'react-dom';
import { gisTier, pgisLabel, posColor, computeCategoryGIS } from '../lib/gis.js';

export default function PlayerModal({ p, onClose }) {
  const cats   = computeCategoryGIS(p, p.ns, p.avgLev, p.oppMod).filter(c => c.gis > 0);
  const maxGis = Math.max(...cats.map(c => c.gis), 0.01);

  const [, tc]         = gisTier(p.gis);
  const pc             = posColor(p.position);
  const [pLabel, pCls] = pgisLabel(p.pGIS);

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="modal-hdr" style={{ borderLeft: `3px solid ${pc}` }}>
          <div className="modal-hdr-left">
            <span className="pos-badge" style={{ background: `${pc}20`, color: pc, borderColor: `${pc}40` }}>
              {p.position}
            </span>
            <span className="modal-name">{p.name}</span>
            <span className="modal-team">{p.team}</span>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {/* Overall scores */}
        <div className="modal-scores">
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
            <span className={`pgis-ctx ${pCls}`} style={{ position: 'static', marginBottom: '0.2rem' }}>{pLabel}</span>
            <span className="modal-score-num">{p.pGIS !== null ? p.pGIS.toFixed(2) : '—'}</span>
            <span className="score-lbl">pGIS</span>
          </div>
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
              <span className="modal-cat-hdrs">GIS / GIS+</span>
            </div>
          ))}
          {cats.length === 0 && (
            <div style={{ color: 'var(--muted)', fontFamily: "'JetBrains Mono',monospace", fontSize: '0.7rem' }}>
              No contributing stats
            </div>
          )}
        </div>

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
      </div>
    </div>,
    document.body
  );
}

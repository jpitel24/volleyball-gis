import { gisTier, pgisLabel, posColor } from '../lib/gis.js';
import { getSchoolColors, hasSchoolColors } from '../data/schoolColors.js';

const OPP_POSITIONS = ['RS','OPP','OP','O','OPPOSITE','OPPO','OUTSIDE','OS'];

function Pills({ p }) {
  const items = [
    [p.kills,         'K',   '#38bdf820', '#38bdf8'],
    [p.assists,       'A',   '#4ade8020', '#4ade80'],
    [p.digs,          'D',   '#facc1520', '#facc15'],
    [p.service_aces,  'Ace', '#f43f5e20', '#f43f5e'],
    [p.block_solos,   'BS',  '#a78bfa20', '#a78bfa'],
    [p.block_assists, 'BA',  '#a78bfa20', '#a78bfa'],
  ].filter(([v]) => v > 0);

  return (
    <div className="pill-row">
      {items.map(([v, lbl, bg, fg]) => (
        <span key={lbl} className="pill" style={{ background: bg, color: fg }}>
          {v}{lbl}
        </span>
      ))}
    </div>
  );
}

export default function PlayerCard({ p, rank, animDelay, onSelect, gameData }) {
  const [, tc]         = gisTier(p.gis);
  const pc             = posColor(p.position);
  const errT           = (p.errors||0)+(p.service_errors||0)+(p.reception_errors||0)+(p.ball_handling_errors||0)+(p.blocking_errors||0);
  const ec             = errT >= 8 ? '#f43f5e' : errT >= 5 ? '#fb923c' : '#94a3b8';

  // Bar capped at 10.0
  const barPct         = p.pGIS !== null ? Math.min((p.pGIS / 10) * 100, 100).toFixed(1) : '0';
  const [pLabel, pCls] = pgisLabel(p.pGIS);
  const pGISVal        = p.pGIS !== null ? p.pGIS.toFixed(2) : '—';
  const displayPos     = OPP_POSITIONS.includes(p.position?.toUpperCase()) ? 'OPP' : (p.position || '?');

  // Tint the pGIS bar with the player's school color when we have one on file.
  // Fallback (no match): undefined style → CSS default blue-orange gradient.
  const barFillStyle   = hasSchoolColors(p.team)
    ? { background: getSchoolColors(p.team).primary }
    : undefined;

  return (
    <div
      className="pcard"
      style={{
        '--pos-color': pc,
        '--tier-color': tc,
        animationDelay: `${animDelay}ms`,
        cursor: onSelect ? 'pointer' : 'default',
      }}
      onClick={onSelect ? () => onSelect(p) : undefined}
    >
      <div className="pcard-top">
        <span className="pos-badge" style={{ background: `${pc}20`, color: pc, borderColor: `${pc}40` }}>
          {displayPos}
        </span>
        <span className="pcard-name">{p.name}</span>
        <span className="match-rank">#{rank}</span>
      </div>

      <div className="scores-row">
        <div className="score-block">
          <span className="score-num" style={{ color: tc }}>{p.gis.toFixed(2)}</span>
          <span className="score-lbl">GIS</span>
        </div>
        <div className="score-divider" />
        <div className="score-block">
          <span className="score-num" style={{ color: 'var(--gisplus)' }}>{p.gisPlus.toFixed(2)}</span>
          <span className="score-lbl">GIS+</span>
        </div>
        <div className="score-divider" />
        {/* pGIS block — tier label above number to prevent overlap */}
        <div className="score-block pgis-block">
          <div className="pgis-label-row">
            <span className={`pgis-ctx ${pCls}`}>{pLabel}</span>
          </div>
          <span className="score-num">{pGISVal}</span>
          <span className="score-lbl">pGIS</span>
        </div>
      </div>

      {/* Bar capped at 10 */}
      <div className="pgis-bar-wrap">
        <div className="pgis-bar-track">
          <div
            className="pgis-bar-fill"
            style={barFillStyle ? { width: `${barPct}%`, ...barFillStyle } : { width: `${barPct}%` }}
          />
        </div>
        <div className="pgis-bar-ticks">
          {['0','2','4','6','8','10'].map(t => <span key={t}>{t}</span>)}
        </div>
      </div>

      <Pills p={p} />

      {/* Efficiency row: hitting, serving, passing, setting.
          Dim cells where attempts = 0 (stat doesn't apply to this role). */}
      <div className="stat-eff-grid">
        {(() => {
          const ta    = p.total_attacks      || 0;
          const sva   = p.serve_attempts     || 0;
          const rca   = p.reception_attempts || 0;
          const sta   = p.set_attempts       || 0;
          const srvPct = sva > 0 ? ((p.service_aces    || 0) - (p.service_errors   || 0)) / sva : 0;
          const recPct = rca > 0 ? (rca - (p.reception_errors || 0)) / rca : 0;
          const setPct = sta > 0 ? ((p.assists         || 0) - (p.set_errors       || 0)) / sta : 0;
          const cell = (label, val, active) => (
            <div className={`stat-cell ${active ? '' : 'stat-cell-dim'}`}>
              <div className="stat-num">{active ? val.toFixed(3) : '—'}</div>
              <div className="stat-lbl">{label}</div>
            </div>
          );
          return (
            <>
              {cell('HIT%', p.hit_pct || 0, ta > 0)}
              {cell('SRV%', srvPct,         sva > 0)}
              {cell('REC%', recPct,         rca > 0)}
              {cell('SET%', setPct,         sta > 0)}
            </>
          );
        })()}
      </div>

      <div className="stat-row-grid">
        <div className="stat-cell"><div className="stat-num">{p.errors||0}</div><div className="stat-lbl">E</div></div>
        <div className="stat-cell"><div className="stat-num">{p.blocking_errors||0}</div><div className="stat-lbl">BE</div></div>
        <div className="stat-cell"><div className="stat-num">{p.ball_handling_errors||0}</div><div className="stat-lbl">BHE</div></div>
        <div className="stat-cell"><div className="stat-num">{p.reception_errors||0}</div><div className="stat-lbl">RE</div></div>
        <div className="stat-cell"><div className="stat-num">{p.service_errors||0}</div><div className="stat-lbl">SE</div></div>
        <div className="stat-cell"><div className="stat-num" style={{ color: ec }}>{errT}</div><div className="stat-lbl">TE</div></div>
      </div>
    </div>
  );
}

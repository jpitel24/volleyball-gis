/**
 * About.jsx — Methodology page explaining GIS, GIS+, and pGIS
 */
export default function About() {
  const benchmarks = [
    { label: 'Top 1%',  val: '9.80', pct: 98 },
    { label: 'Top 5%',  val: '9.03', pct: 90 },
    { label: 'Top 10%', val: '8.10', pct: 81 },
    { label: 'Top 25%', val: '5.63', pct: 56 },
  ];

  const actionWeights = [
    ['Kill', '1.00'],
    ['Ace', '1.20'],
    ['Block Solo', '1.10'],
    ['Assist', '0.28'],
    ['Block Assist', '0.50'],
    ['Dig', '0.35'],
  ];

  return (
    <div className="about-wrap">
      <div className="about-hero">
        <div className="hero-eyebrow">Methodology</div>
        <h1 className="about-title">How GIS Works</h1>
        <p className="about-sub">
          Three metrics that measure volleyball performance at the player level —
          from raw contribution to cross-team comparison.
        </p>
      </div>

      {/* ── GIS ── */}
      <section className="about-section">
        <div className="about-metric-badge" style={{ color: '#38bdf8', borderColor: '#38bdf840', background: '#38bdf808' }}>
          GIS
        </div>
        <h2 className="about-section-title">Game Impact Score</h2>
        <p className="about-body">
          GIS counts what a player actually did in a match and weights each action by how much
          it typically generates scoring opportunities. Kills, service aces, block solos, assists,
          block assists, and digs are each assigned a weight — summed up, divided by sets played,
          then multiplied by a leverage factor that rises in closer or longer matches.
        </p>
        <p className="about-body">
          An error penalty reduces the score when a player accumulates errors relative to their
          positive production. The final value is scaled by 1.25 to produce a readable range — a
          strong all-around performance in a contested 5-set match typically lands between 8–14.
        </p>
        <div className="about-formula">
          GIS = (Weighted Volume ÷ Sets) × Leverage × Error Penalty × 1.25
        </div>
        <div className="about-weights">
          {actionWeights.map(([n, v]) => (
            <span key={n} className="about-wchip">
              <span>{n}</span>
              <strong>{v}×</strong>
            </span>
          ))}
        </div>
      </section>

      {/* ── GIS+ ── */}
      <section className="about-section">
        <div className="about-metric-badge" style={{ color: '#e879f9', borderColor: '#e879f940', background: '#e879f908' }}>
          GIS+
        </div>
        <h2 className="about-section-title">Opponent-Adjusted GIS</h2>
        <p className="about-body">
          GIS+ multiplies the raw GIS by a modifier based on the opponent's RPI rank. The same
          statistical line against a top-10 program is worth more than the same line against a
          team ranked 300th — opponent difficulty is separate from match importance, which is
          already captured in the leverage factor.
        </p>
        <p className="about-body">
          The modifier runs from <strong style={{ color: '#4ade80' }}>+5%</strong> for playing
          the #1-ranked team down through neutral at approximately rank 50, continuing to
          <strong style={{ color: '#f43f5e' }}> −50%</strong> for the weakest opponents.
        </p>
        <div className="about-modifier-scale">
          <div className="about-mod-row">
            <span className="about-mod-label">#1 opponent</span>
            <div className="about-mod-track">
              <div className="about-mod-bar" style={{ width: '100%', background: '#4ade80' }} />
            </div>
            <span className="about-mod-val" style={{ color: '#4ade80' }}>+5.0%</span>
          </div>
          <div className="about-mod-row">
            <span className="about-mod-label">#50 opponent</span>
            <div className="about-mod-track">
              <div className="about-mod-bar" style={{ width: '55%', background: '#38bdf8' }} />
            </div>
            <span className="about-mod-val" style={{ color: 'var(--muted)' }}>neutral</span>
          </div>
          <div className="about-mod-row">
            <span className="about-mod-label">last place</span>
            <div className="about-mod-track">
              <div className="about-mod-bar" style={{ width: '8%', background: '#f43f5e' }} />
            </div>
            <span className="about-mod-val" style={{ color: '#f43f5e' }}>−50%</span>
          </div>
        </div>
        <p className="about-body" style={{ marginTop: '0.9rem' }}>
          Modifier formula: <code className="about-code">1 + (rpi_value − 0.500) × 0.63</code> with
          floors/ceilings at 0.50× and 1.05×. Neutral at RPI value 0.500 (approximately rank 50 in a
          typical D1 season).
        </p>
      </section>

      {/* ── pGIS ── */}
      <section className="about-section">
        <div className="about-metric-badge" style={{ color: '#fb923c', borderColor: '#fb923c40', background: '#fb923c08' }}>
          pGIS
        </div>
        <h2 className="about-section-title">Positional GIS</h2>
        <p className="about-body">
          pGIS answers: <em>"How did this player rank compared to everyone else who plays their
          position?"</em> It takes the opponent-adjusted per-set efficiency, finds where it falls in
          a distribution of all D1 performances at the same position in similar-length matches, then
          converts that percentile to a 0–10 scale using a power curve (pGIS = 10 × percentile²).
        </p>
        <p className="about-body">
          A game only counts toward pGIS if the opponent was in the <strong>top 100 by RPI</strong>{' '}
          and the player appeared in at least half the sets. This filters out blowouts against weak
          opponents, making pGIS the most direct apples-to-apples comparison between players across
          different programs and schedules.
        </p>
        <div className="about-pgis-scale">
          {benchmarks.map(b => (
            <div key={b.label} className="about-pgis-row">
              <span className="about-pgis-label">{b.label}</span>
              <div className="about-pgis-track">
                <div className="about-pgis-bar" style={{ width: `${b.pct}%` }} />
              </div>
              <span className="about-pgis-val">{b.val}</span>
            </div>
          ))}
          <div className="about-pgis-note">
            Hard ceiling: 10.0 · Power curve: pGIS = 10 × (percentile)² · Calibrated from all
            D1 matches 2022–2025 · Position + set-count matched
          </div>
        </div>
        <p className="about-body" style={{ marginTop: '0.9rem' }}>
          The 0–10 scale compresses at the top intentionally — moving from 9.0 to 9.5 requires
          dramatically better performance than moving from 5.0 to 5.5, reflecting how rare true
          elite-level efficiency is at any position.
        </p>
      </section>

      {/* ── Tiers ── */}
      <section className="about-section">
        <div className="about-metric-badge" style={{ color: '#94a3b8', borderColor: '#94a3b840', background: 'transparent' }}>
          TIERS
        </div>
        <h2 className="about-section-title">Performance Tiers</h2>
        <div className="about-tier-grid">
          <div className="about-tier-col">
            <div className="about-tier-header">GIS Tiers</div>
            {[['ELITE','≥ 10','#f43f5e'],['IMPACT','≥ 7','#fb923c'],['SOLID','≥ 4.5','#4ade80'],['PRESENT','≥ 2.5','#38bdf8'],['LIMITED','< 2.5','#64748b']].map(([t,r,c])=>(
              <div key={t} className="about-tier-row">
                <span className="about-tier-badge" style={{ color: c, borderColor: `${c}40`, background: `${c}0d` }}>{t}</span>
                <span className="about-tier-range">{r}</span>
              </div>
            ))}
          </div>
          <div className="about-tier-col">
            <div className="about-tier-header">pGIS Tiers</div>
            {[['ELITE','≥ 9.5','#f43f5e'],['IMPACT','≥ 8.5','#fb923c'],['SOLID','≥ 7.5','#38bdf8'],['GOOD','≥ 6.0','#38bdf8'],['AVG','≥ 4.0','#64748b'],['BELOW','≥ 2.0','#64748b'],['LTD','< 2.0','#475569']].map(([t,r,c])=>(
              <div key={t} className="about-tier-row">
                <span className="about-tier-badge" style={{ color: c, borderColor: `${c}40`, background: `${c}0d` }}>{t}</span>
                <span className="about-tier-range">{r}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

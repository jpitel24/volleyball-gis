import { hrefFor, useLinkHandler } from '../lib/router.js';
import { posColor } from '../lib/gis.js';

// Auto-stamped at build time so the About page reflects what's actually
// deployed. Vite inlines `new Date()` evaluated at build, not runtime.
const BUILD_DATE = new Date(__BUILD_DATE__ || Date.now()).toLocaleDateString(
  undefined, { year: 'numeric', month: 'long', day: 'numeric' }
);

function ToolLink({ to, children }) {
  const onClick = useLinkHandler();
  return <a href={to} onClick={onClick} className="about-tool-link">{children}</a>;
}

export default function About() {
  const onClick = useLinkHandler();
  return (
    <>
      <div className="hero">
        <div className="hero-eyebrow">NCAA D1 Women's Volleyball · GIS Analytics</div>
        <div className="hero-title">Volleyball GIS</div>
        <div className="hero-sub">
          A performance-analytics layer over every D1 women's volleyball
          match. Quantifies player impact per set, adjusts for opponent
          strength and match leverage, and ranks players against their
          position peers.
        </div>
      </div>

      <div className="about-wrap">

        {/* ─────────────── Overview ─────────────── */}
        <section className="about-section">
          <h2>What this is</h2>
          <p>
            Volleyball GIS turns NCAA box scores into per-set, per-opponent,
            per-leverage performance ratings for every D1 player. The four
            tools above let you drill in from any angle — a single match, a
            player's career arc, a position-group leaderboard, or a team's
            full roster.
          </p>
          <p>
            The current build covers the <strong>2022–2025</strong> D1 seasons,
            with <strong>2026</strong> slots ready to fill as the season plays
            out. Live in-season tracking arrives once the 2026 season opens
            in August — week-over-week updates, freshly-computed leaderboards,
            and game reports as soon as the box scores hit the wire.
          </p>
          <p style={{ color: 'var(--muted)', fontSize: '0.85em' }}>
            Note: NCAA's official RPI rankings don't publish until several
            weeks into the season. Until then, opponent-strength adjustments
            for 2026 matches fall back to the 2025 end-of-season RPI —
            close enough for most programs, and every 2026 match's GIS+
            gets recomputed once real 2026 RPI is available.
          </p>
        </section>

        {/* ─────────────── Metric explanations ─────────────── */}
        <section className="about-section">
          <h2>The metrics</h2>

          <div className="about-metric">
            <div className="about-metric-name">GIS</div>
            <div className="about-metric-tag">Game Impact Score</div>
            <p>
              A per-set composite of everything a player did on the floor:
              attacking, blocking, defending, serving, and setting.
              Negatives count too — errors and lost-point actions pull the
              number down. Higher GIS means more impact per set played.
            </p>
          </div>

          <div className="about-metric">
            <div className="about-metric-name" style={{ color: 'var(--gisplus)' }}>GIS+</div>
            <div className="about-metric-tag">Context-adjusted GIS</div>
            <p>
              GIS, but adjusted for who you played and how much was on the
              line. A point earned against a top-10 opponent counts for
              more than the same point against a #300 opponent. Production
              in a tight 5-set match counts for more than production in a
              blowout sweep. GIS+ is the headline production rate
              everywhere on this site.
            </p>
          </div>

          <div className="about-metric">
            <div className="about-metric-name" style={{ color: 'var(--pgis)' }}>pGIS</div>
            <div className="about-metric-tag">Percentile GIS, 0–10 scale</div>
            <p>
              How a player's per-set GIS+ ranks against the elite cohort —
              D1 starters at the same position playing in matches between
              two top-100 RPI teams. A pGIS of 7.5 means the player's rate
              would land at the 75th percentile of that cohort. 9+ is
              All-American territory; 5 is a rotation regular.
            </p>
          </div>
        </section>

        {/* ─────────────── Tool guide ─────────────── */}
        <section className="about-section">
          <h2>The four tools</h2>
          <ul className="about-tools">
            <li>
              <ToolLink to={hrefFor('games')}>Games</ToolLink>{' '}
              — Pick a match, see the full box score with GIS, GIS+, pGIS
              for every player on the floor.
            </li>
            <li>
              <ToolLink to={hrefFor('players')}>Players</ToolLink>{' '}
              — Search a player, see career totals and a per-season /
              per-game drill-down. Includes splits against RPI Top-50
              opponents.
            </li>
            <li>
              <ToolLink to={hrefFor('seasons')}>Seasons</ToolLink>{' '}
              — Position-filtered leaderboards by year or all-time. Sort
              by GIS+, pGIS, or their Top-50 splits.
            </li>
            <li>
              <ToolLink to={hrefFor('teams')}>Teams</ToolLink>{' '}
              — Pick a year and a team; see the full roster ranked by
              GIS+, plus team-aggregate metrics.
            </li>
          </ul>
        </section>

        {/* ─────────────── FAQ-ish: position groups ─────────────── */}
        <section className="about-section">
          <h2>Position groups & color codes</h2>
          <p>
            Players are bucketed into four groups for ranking. Color
            coding in the UI matches:
          </p>
          <ul className="about-list">
            <li><span className="about-pos-chip" style={{ color: posColor('OH') }}>OH</span> — Outside Hitter (includes RS / OPP / right-side variants)</li>
            <li><span className="about-pos-chip" style={{ color: posColor('MB') }}>MB</span> — Middle Blocker (includes MH)</li>
            <li><span className="about-pos-chip" style={{ color: posColor('S')  }}>S</span>  — Setter</li>
            <li><span className="about-pos-chip" style={{ color: posColor('L')  }}>L</span>  — Libero / Defensive Specialist (includes DS / LB)</li>
          </ul>
        </section>

        <section className="about-section">
          <h2>What's "T50"?</h2>
          <p>
            Several views surface a "T50" split column — that's the
            player's GIS / GIS+ / pGIS computed only over their games
            against RPI Top-50 opponents that season. It's the cleanest
            single-number test for "how does this player do when the
            schedule gets hard?" In Player and Season Browsers the column
            is labeled <code>T50 GIS+/S</code> and friends.
          </p>
        </section>

        <section className="about-section">
          <h2>Power vs. mid-major</h2>
          <p>
            The pGIS percentile baseline is built only from games where
            both teams are RPI top-100 that season. A mid-major star
            stat-padding against weak conference opponents won't anchor
            the curve, so their pGIS reflects how their per-set production
            stacks up against actual elite-cohort starters.
          </p>
          <p>
            The Season Browser has one more guardrail: a player must have
            appeared in at least <strong>75% of their team's games</strong>{' '}
            for the season to chart on the leaderboard. Without the floor,
            one-game cameos (a single huge match, then injury) dominate
            the all-time pGIS list because their season pGIS is a
            single-game outlier average.
          </p>
        </section>

        <section className="about-section">
          <h2>Data caveats</h2>
          <ul className="about-list">
            <li>
              <strong>NCAA box scores</strong> are the source. Stat-keeping
              quality varies by program; some categories (defensive
              actions, ball-handling errors) are noisier than others.
            </li>
            <li>
              <strong>DNP ghost rows filtered.</strong> The NCAA CSV
              credits every rostered player with the match's total sets
              even when they didn't take the floor. We drop any row where
              every counting stat is zero so those don't pollute averages.
            </li>
            <li>
              <strong>RPI is end-of-season</strong> for each year. We
              don't currently track the in-season RPI snapshot at the
              moment a match was played.
            </li>
            <li>
              <strong>Same-name collisions</strong> are rare but possible
              when two players share a full name on the same team in the
              same season. Player records are keyed on name only.
            </li>
          </ul>
        </section>

        {/* ─────────────── Footer ─────────────── */}
        <section className="about-section about-footer">
          <p>
            <a
              href="https://github.com/jpitel24/volleyball-gis"
              target="_blank"
              rel="noopener noreferrer"
            >
              github.com/jpitel24/volleyball-gis
            </a>
            {' · '}
            Built with React + Vite. Deployed on Vercel.
            {' · '}
            Last updated <strong>{BUILD_DATE}</strong>.
          </p>
        </section>

      </div>
    </>
  );
}

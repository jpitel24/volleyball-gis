import { getSchoolColors, hasSchoolColors } from '../data/schoolColors.js';
import { getTeamLogo, hasTeamLogo } from '../data/teamLogos.js';

/**
 * TeamChip — a compact visual identity for a school. Prefers the
 * actual team logo (downloaded from ESPN via scripts/build_team_logos.py),
 * and falls back to a colored dot in the school's primary brand color
 * for the ~13 D1 programs ESPN doesn't carry logos for. Renders nothing
 * when we have neither, so we never paint a misleading neutral token.
 */
export default function TeamChip({ team, size = 8, style }) {
  if (!team) return null;

  const logo = getTeamLogo(team);
  if (logo) {
    return (
      <img
        src={logo}
        alt=""
        aria-hidden="true"
        className="team-chip team-chip-logo"
        loading="lazy"
        style={{
          width: size,
          height: size,
          objectFit: 'contain',
          verticalAlign: 'middle',
          marginRight: '0.4em',
          flexShrink: 0,
          ...style,
        }}
      />
    );
  }

  if (!hasSchoolColors(team)) return null;
  const { primary } = getSchoolColors(team);
  return (
    <span
      className="team-chip"
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: primary,
        marginRight: '0.4em',
        verticalAlign: 'middle',
        flexShrink: 0,
        ...style,
      }}
    />
  );
}

import { getSchoolColors, hasSchoolColors } from '../data/schoolColors.js';

/**
 * TeamChip — a small colored dot showing a school's primary brand color
 * next to its name. Poor-man's team logo: instant visual identity in
 * lists and tables without shipping ~340 logo files.
 *
 * Renders a compact inline-block circle. Skips output entirely when the
 * school isn't in schoolColors.js so we don't paint a misleading neutral
 * dot for programs we don't have data for.
 */
export default function TeamChip({ team, size = 8, style }) {
  if (!team || !hasSchoolColors(team)) return null;
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

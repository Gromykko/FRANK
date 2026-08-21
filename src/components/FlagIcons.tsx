// Inline SVG flags (emoji flags render as plain letters on Windows), clipped
// to a rounded rect so they sit nicely inside the round push-button.
// Dannebrog: white cross arms 2/7 of the height, vertical arm centered at
// 3/7 of the width (toward the hoist).
export function FlagDK() {
  return (
    <svg className="flag-icon" viewBox="0 0 20 14" aria-hidden="true">
      <clipPath id="flag-dk-clip">
        <rect width="20" height="14" rx="2.5" />
      </clipPath>
      <g clipPath="url(#flag-dk-clip)">
        <rect width="20" height="14" fill="#C8102E" />
        <rect x="6.57" width="4" height="14" fill="#FFFFFF" />
        <rect y="5" width="20" height="4" fill="#FFFFFF" />
      </g>
    </svg>
  );
}

// Simplified Union Jack: blue field, white diagonals with thinner red
// diagonals, red central cross with a white fringe.
export function FlagUK() {
  return (
    <svg className="flag-icon" viewBox="0 0 20 14" aria-hidden="true">
      <clipPath id="flag-uk-clip">
        <rect width="20" height="14" rx="2.5" />
      </clipPath>
      <g clipPath="url(#flag-uk-clip)">
        <rect width="20" height="14" fill="#012169" />
        <path d="M0 0 L20 14 M20 0 L0 14" stroke="#FFFFFF" strokeWidth="3" />
        <path d="M0 0 L20 14 M20 0 L0 14" stroke="#C8102E" strokeWidth="1.2" />
        <rect x="7.5" width="5" height="14" fill="#FFFFFF" />
        <rect y="4.5" width="20" height="5" fill="#FFFFFF" />
        <rect x="8.5" width="3" height="14" fill="#C8102E" />
        <rect y="5.5" width="20" height="3" fill="#C8102E" />
      </g>
    </svg>
  );
}

import { memo } from 'react';

/**
 * FORK: "JA toolbox" monogram icon. Uses `currentColor` so it themes with the button
 * (base vs invokeBlue when a JA tool is active). Sized `1em` to match react-icons.
 */
export const JaToolboxIcon = memo(() => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <text
      x="12"
      y="12"
      textAnchor="middle"
      dominantBaseline="central"
      fontSize="11"
      fontWeight="700"
      fill="currentColor"
    >
      JA
    </text>
  </svg>
));

JaToolboxIcon.displayName = 'JaToolboxIcon';

/**
 * Stremio addon manifest. Owned by LEAD.
 * @see https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/manifest.md
 */
import { getConfig } from '../env.js';

export const ADDON_ID = 'org.nuviosync.subtitles';
export const ADDON_VERSION = '0.1.0';

/**
 * @param {{baseUrl:string}} opts
 * @returns {object} manifest
 */
export function buildManifest({ baseUrl } = { baseUrl: '' }) {
  const config = getConfig();
  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: 'Nuvio Sync Subtitles',
    description:
      'Subtitle addon with Nuvio-style auto sync: cross-subtitle text alignment, LLM cue matching '
      + '(Groq/Gemini) and audio alignment, applied by rewriting timestamps before Stremio plays them. '
      + 'Offsets are remembered per video, and a Sync Lab page lets you calibrate one tap at a time. '
      + 'It also lists the playable links of the stream addon you already use, so they stay visible '
      + 'in Stremio while the subtitle sync borrows the same file.',
    logo: baseUrl ? `${baseUrl}/assets/logo.svg` : undefined,
    background: baseUrl ? `${baseUrl}/assets/background.svg` : undefined,
    resources: ['subtitles', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
      adult: false,
    },
    // Non-standard, harmless extras some clients surface in the UI.
    addonCatalogs: undefined,
    contactEmail: undefined,
    ...(config.PREFERRED_LANGS?.length
      ? { subtitleLanguages: config.PREFERRED_LANGS }
      : {}),
  };
}

/** Minimal inline SVG assets so the addon never depends on an external host. */
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#22d3ee"/>
  </linearGradient></defs>
  <rect width="256" height="256" rx="56" fill="#0f1115"/>
  <rect x="24" y="52" width="208" height="132" rx="20" fill="none" stroke="url(#g)" stroke-width="8"/>
  <rect x="52" y="150" width="152" height="14" rx="7" fill="url(#g)"/>
  <rect x="52" y="116" width="104" height="14" rx="7" fill="#f5f7fb" opacity=".85"/>
  <path d="M112 88 l56 32 -56 32z" fill="#22d3ee" opacity=".9"/>
</svg>`;

export const BACKGROUND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
  <defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#0b0d12"/><stop offset="1" stop-color="#1b1330"/>
  </linearGradient></defs>
  <rect width="1280" height="720" fill="url(#b)"/>
  <g fill="#7c5cff" opacity=".18">
    <circle cx="180" cy="560" r="220"/><circle cx="1120" cy="180" r="260"/>
  </g>
</svg>`;

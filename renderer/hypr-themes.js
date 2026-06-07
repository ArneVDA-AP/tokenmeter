// App-wide theme system for Tokenmeter.
// Themes are applied to :root (document.documentElement) setting both the
// app-level vars (--bg, --surface, --orange, etc.) used throughout the UI
// and the Sessions-surface --h-* vars consumed by the Hyprland compositor view.
// The 5 Hyprland palettes (nord, everforest, gruvbox, macchiato, rosepine) are
// unchanged; 'tokenmeter' is added as the default neutral-gray + orange look.

window.APP_THEMES = {
  tokenmeter: {
    label: 'Tokenmeter',
    bg: '#161616', bgPanel: 'rgba(22,22,22,0.88)', bgWindow: '#1e1e1e',
    bgWindowActive: '#252525', bgTitlebar: '#1e1e1e',
    borderActive1: '#e8650a', borderActive2: '#f07020', borderInactive: '#2e2e2e', borderHi: '#3d3d3d',
    fg: '#e8e8e8', fgDim: '#b0b0b0', fgMeta: '#707070', fgBright: '#ffffff',
    red: '#e0431a', green: '#4caf75', yellow: '#f07020', blue: '#4a9eff',
    magenta: '#e8650a', cyan: '#4a9eff', accent: '#e8650a', accentAlt: '#f07020',
    selBg: 'rgba(232,101,10,0.13)', shadowColor: 'rgba(0,0,0,0.30)',
  },
  nord: {
    label: 'Nord',
    bg: '#2e3440', bgPanel: 'rgba(46,52,64,0.88)', bgWindow: '#2e3440',
    bgWindowActive: '#3b4252', bgTitlebar: '#3b4252',
    borderActive1: '#81a1c1', borderActive2: '#88c0d0', borderInactive: '#434c5e', borderHi: '#4c566a',
    fg: '#d8dee9', fgDim: '#7b88a1', fgMeta: '#4c566a', fgBright: '#eceff4',
    red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1',
    magenta: '#b48ead', cyan: '#88c0d0', accent: '#81a1c1', accentAlt: '#88c0d0',
    selBg: 'rgba(129,161,193,0.13)', shadowColor: 'rgba(0,0,0,0.30)',
  },
  everforest: {
    label: 'Everforest',
    bg: '#2d353b', bgPanel: 'rgba(45,53,59,0.88)', bgWindow: '#2d353b',
    bgWindowActive: '#343f44', bgTitlebar: '#343f44',
    borderActive1: '#a7c080', borderActive2: '#7fbbb3', borderInactive: '#475258', borderHi: '#56635f',
    fg: '#d3c6aa', fgDim: '#859289', fgMeta: '#4f585e', fgBright: '#e6e2cc',
    red: '#e67e80', green: '#a7c080', yellow: '#dbbc7f', blue: '#7fbbb3',
    magenta: '#d699b6', cyan: '#83c092', accent: '#7fbbb3', accentAlt: '#a7c080',
    selBg: 'rgba(127,187,179,0.13)', shadowColor: 'rgba(0,0,0,0.32)',
  },
  gruvbox: {
    label: 'Gruvbox',
    bg: '#282828', bgPanel: 'rgba(40,40,40,0.90)', bgWindow: '#282828',
    bgWindowActive: '#32302f', bgTitlebar: '#3c3836',
    borderActive1: '#d8a657', borderActive2: '#7daea3', borderInactive: '#504945', borderHi: '#665c54',
    fg: '#ebdbb2', fgDim: '#a89984', fgMeta: '#665c54', fgBright: '#fbf1c7',
    red: '#ea6962', green: '#a9b665', yellow: '#d8a657', blue: '#7daea3',
    magenta: '#d3869b', cyan: '#89b482', accent: '#7daea3', accentAlt: '#d8a657',
    selBg: 'rgba(125,174,163,0.13)', shadowColor: 'rgba(0,0,0,0.35)',
  },
  macchiato: {
    label: 'Macchiato',
    bg: '#24273a', bgPanel: 'rgba(36,39,58,0.90)', bgWindow: '#24273a',
    bgWindowActive: '#1e2030', bgTitlebar: '#363a4f',
    borderActive1: '#8aadf4', borderActive2: '#c6a0f6', borderInactive: '#494d64', borderHi: '#5b6078',
    fg: '#cad3f5', fgDim: '#8087a2', fgMeta: '#5b6078', fgBright: '#ffffff',
    red: '#ed8796', green: '#a6da95', yellow: '#eed49f', blue: '#8aadf4',
    magenta: '#c6a0f6', cyan: '#8bd5ca', accent: '#8aadf4', accentAlt: '#c6a0f6',
    selBg: 'rgba(138,173,244,0.13)', shadowColor: 'rgba(0,0,0,0.40)',
  },
  rosepine: {
    label: 'Rosé Pine',
    bg: '#232136', bgPanel: 'rgba(35,33,54,0.90)', bgWindow: '#232136',
    bgWindowActive: '#2a273f', bgTitlebar: '#2a283e',
    borderActive1: '#c4a7e7', borderActive2: '#ebbcba', borderInactive: '#44415a', borderHi: '#56526e',
    fg: '#e0def4', fgDim: '#908caa', fgMeta: '#6e6a86', fgBright: '#ffffff',
    red: '#eb6f92', green: '#9ccfd8', yellow: '#f6c177', blue: '#3e8fb0',
    magenta: '#c4a7e7', cyan: '#9ccfd8', accent: '#c4a7e7', accentAlt: '#ebbcba',
    selBg: 'rgba(196,167,231,0.13)', shadowColor: 'rgba(0,0,0,0.40)',
  },
};

window.APP_THEME_ORDER = ['tokenmeter', 'nord', 'everforest', 'gruvbox', 'macchiato', 'rosepine'];

// Map theme object keys onto the --h-* CSS custom properties consumed by the
// Sessions surface stylesheet.
const HYPR_VAR_MAP = {
  bg: '--h-bg', bgPanel: '--h-panel', bgWindow: '--h-window',
  bgWindowActive: '--h-window-active', bgTitlebar: '--h-titlebar',
  borderActive1: '--h-b1', borderActive2: '--h-b2', borderInactive: '--h-border',
  fg: '--h-fg', fgDim: '--h-fg-dim', fgMeta: '--h-fg-meta', fgBright: '--h-fg-bright',
  red: '--h-red', green: '--h-green', yellow: '--h-yellow', blue: '--h-blue',
  magenta: '--h-magenta', cyan: '--h-cyan', accent: '--h-accent', accentAlt: '--h-accent-alt',
  selBg: '--h-sel', shadowColor: '--h-shadow',
};

// applyTheme(key) — sets both --h-* and app-level vars on :root, making the
// chosen theme active across the whole application.
window.applyTheme = function (key) {
  const resolved = (window.APP_THEMES[key] ? key : 'tokenmeter');
  const theme = window.APP_THEMES[resolved];
  const root = document.documentElement;

  // (a) Sessions-surface --h-* vars
  for (const [prop, cssVar] of Object.entries(HYPR_VAR_MAP)) {
    root.style.setProperty(cssVar, theme[prop]);
  }

  // (b) App-level vars — listed individually so multiple keys can map to the
  //     same target var (e.g. accent → --border-hi, --orange, --creature).
  root.style.setProperty('--bg',          theme.bg);
  root.style.setProperty('--surface',     theme.bgWindow);
  root.style.setProperty('--surface2',    theme.bgWindowActive);
  root.style.setProperty('--border',      theme.borderInactive);
  root.style.setProperty('--border-hi',   theme.borderHi || theme.accent);
  root.style.setProperty('--orange',      theme.accent);
  root.style.setProperty('--text',        theme.fg);
  root.style.setProperty('--text-muted',  theme.fgDim);
  root.style.setProperty('--text-dim',    theme.fgMeta);
  root.style.setProperty('--green',       theme.green);
  root.style.setProperty('--warn',        theme.red);
  root.style.setProperty('--gemini',      theme.blue);
  root.style.setProperty('--creature',    theme.accent);

  root.dataset.theme = resolved;
  return theme;
};

// ── Backward compatibility ───────────────────────────────────────────────────
// Other files still reference the old HYPR_* names and applyHyprTheme.
window.HYPR_THEMES      = window.APP_THEMES;
window.HYPR_THEME_ORDER = window.APP_THEME_ORDER;
// el argument is ignored; theme is now applied globally to :root.
window.applyHyprTheme = function (el, key) { return window.applyTheme(key); };

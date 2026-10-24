export interface ThemeColors {
  bg: string
  panel: string
  surface: string
  surface2: string
  border: string
  borderStrong: string
  text: string
  muted: string
  accent: string
  accent2: string
  green: string
  red: string
  yellow: string
  shadow: string
}

export interface ThemeDef {
  id: string
  label: string
  mode: 'dark' | 'light'
  colors: ThemeColors
}

export const THEMES: ThemeDef[] = [
  {
    id: 'dracula',
    label: 'Dracula',
    mode: 'dark',
    colors: {
      bg: '#282a36',
      panel: '#21222c',
      surface: '#343746',
      surface2: '#3d4050',
      border: '#44475a',
      borderStrong: '#6f7590',
      text: '#f8f8f2',
      muted: '#a6adc8',
      accent: '#bd93f9',
      accent2: '#8be9fd',
      green: '#50fa7b',
      red: '#ff5555',
      yellow: '#f1fa8c',
      shadow: 'rgba(0,0,0,0.45)'
    }
  },
  {
    id: 'aura',
    label: 'Aura',
    mode: 'dark',
    colors: {
      bg: '#0f0f14',
      panel: '#15151f',
      surface: '#1d1d2b',
      surface2: '#26263a',
      border: '#2a2a3d',
      borderStrong: '#5f5f88',
      text: '#e6e6f0',
      muted: '#9a9ab4',
      accent: '#a277ff',
      accent2: '#61ffca',
      green: '#61ffca',
      red: '#ff6767',
      yellow: '#ffca85',
      shadow: 'rgba(0,0,0,0.55)'
    }
  },
  {
    id: 'matrix',
    label: 'Matrix',
    mode: 'dark',
    colors: {
      bg: '#000000',
      panel: '#050805',
      surface: '#0a120a',
      surface2: '#102010',
      border: '#173d17',
      borderStrong: '#2f7a2f',
      text: '#b8ffb8',
      muted: '#6faf6f',
      accent: '#00ff41',
      accent2: '#7dff9b',
      green: '#00ff41',
      red: '#ff4141',
      yellow: '#d4ff41',
      shadow: 'rgba(0,255,65,0.12)'
    }
  },
  {
    id: 'neon',
    label: 'Neon',
    mode: 'dark',
    colors: {
      bg: '#0a0a12',
      panel: '#10101c',
      surface: '#171728',
      surface2: '#1f1f36',
      border: '#2b2b4a',
      borderStrong: '#63639e',
      text: '#e8e8ff',
      muted: '#9292c0',
      accent: '#ff2bd6',
      accent2: '#00e5ff',
      green: '#39ff88',
      red: '#ff3860',
      yellow: '#ffe066',
      shadow: 'rgba(255,43,214,0.18)'
    }
  },
  {
    id: 'pycharm',
    label: 'PyCharm',
    mode: 'dark',
    colors: {
      bg: '#2b2b2b',
      panel: '#313335',
      surface: '#3c3f41',
      surface2: '#45494a',
      border: '#4e5254',
      borderStrong: '#787f84',
      text: '#b8c2cc',
      muted: '#a8b0b6',
      accent: '#cc7832',
      accent2: '#8fbd6e',
      green: '#8fbd6e',
      red: '#ff6b6b',
      yellow: '#ffc66d',
      shadow: 'rgba(0,0,0,0.35)'
    }
  },
  {
    id: 'dark',
    label: 'DBLion Dark',
    mode: 'dark',
    colors: {
      bg: '#11111b',
      panel: '#181825',
      surface: '#1e1e2e',
      surface2: '#252537',
      border: '#313244',
      borderStrong: '#64688c',
      text: '#cdd6f4',
      muted: '#9399b2',
      accent: '#89b4fa',
      accent2: '#94e2d5',
      green: '#a6e3a1',
      red: '#f38ba8',
      yellow: '#f9e2af',
      shadow: 'rgba(0,0,0,0.45)'
    }
  },
  {
    id: 'tokyo',
    label: 'Tokyo Night',
    mode: 'dark',
    colors: {
      bg: '#1a1b26',
      panel: '#16161e',
      surface: '#24283b',
      surface2: '#2f3549',
      border: '#3b4261',
      borderStrong: '#545c7e',
      text: '#c0caf5',
      muted: '#9aa5ce',
      accent: '#7aa2f7',
      accent2: '#7dcfff',
      green: '#9ece6a',
      red: '#f7768e',
      yellow: '#e0af68',
      shadow: 'rgba(0,0,0,0.5)'
    }
  },
  {
    id: 'nord',
    label: 'Nord',
    mode: 'dark',
    colors: {
      bg: '#2e3440',
      panel: '#292e39',
      surface: '#3b4252',
      surface2: '#434c5e',
      border: '#4c566a',
      borderStrong: '#616e88',
      text: '#eceff4',
      muted: '#b4bccb',
      accent: '#88c0d0',
      accent2: '#8fbcbb',
      green: '#a3be8c',
      red: '#bf616a',
      yellow: '#ebcb8b',
      shadow: 'rgba(0,0,0,0.4)'
    }
  },
  {
    id: 'catppuccin',
    label: 'Catppuccin',
    mode: 'dark',
    colors: {
      bg: '#1e1e2e',
      panel: '#181825',
      surface: '#313244',
      surface2: '#45475a',
      border: '#585b70',
      borderStrong: '#7f849c',
      text: '#cdd6f4',
      muted: '#a6adc8',
      accent: '#cba6f7',
      accent2: '#89dceb',
      green: '#a6e3a1',
      red: '#f38ba8',
      yellow: '#f9e2af',
      shadow: 'rgba(0,0,0,0.45)'
    }
  },
  {
    id: 'light',
    label: 'Light',
    mode: 'light',
    colors: {
      bg: '#f7f7fa',
      panel: '#ffffff',
      surface: '#eef0f5',
      surface2: '#e2e5ee',
      border: '#d7dae3',
      borderStrong: '#767e8c',
      text: '#1f2430',
      muted: '#5f6775',
      accent: '#4f46e5',
      accent2: '#0b6b85',
      green: '#15803d',
      red: '#b91c1c',
      yellow: '#a16207',
      shadow: 'rgba(30,41,59,0.12)'
    }
  },
  {
    id: 'gruvbox',
    label: 'Gruvbox',
    mode: 'dark',
    colors: {
      bg: '#282828',
      panel: '#1d2021',
      surface: '#32302f',
      surface2: '#3c3836',
      border: '#504945',
      borderStrong: '#928374',
      text: '#ebdbb2',
      muted: '#a89984',
      accent: '#fabd2f',
      accent2: '#83a598',
      green: '#b8bb26',
      red: '#fb4934',
      yellow: '#fabd2f',
      shadow: 'rgba(0,0,0,0.5)'
    }
  },
  {
    id: 'rose-pine',
    label: 'Rosé Pine',
    mode: 'dark',
    colors: {
      bg: '#191724',
      panel: '#1f1d2e',
      surface: '#26233a',
      surface2: '#403d52',
      border: '#524f67',
      borderStrong: '#6e6a86',
      text: '#e0def4',
      muted: '#908caa',
      accent: '#c4a7e7',
      accent2: '#9ccfd8',
      green: '#9ccfd8',
      red: '#eb6f92',
      yellow: '#f6c177',
      shadow: 'rgba(0,0,0,0.55)'
    }
  },
  {
    id: 'one-dark',
    label: 'One Dark',
    mode: 'dark',
    colors: {
      bg: '#282c34',
      panel: '#21252b',
      surface: '#2c313a',
      surface2: '#333842',
      border: '#3e4451',
      borderStrong: '#5c6370',
      text: '#abb2bf',
      muted: '#7f848e',
      accent: '#61afef',
      accent2: '#56b6c2',
      green: '#98c379',
      red: '#e06c75',
      yellow: '#e5c07b',
      shadow: 'rgba(0,0,0,0.45)'
    }
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    mode: 'light',
    colors: {
      bg: '#fdf6e3',
      panel: '#fffbf0',
      surface: '#eee8d5',
      surface2: '#e6dfc8',
      border: '#d9d2c0',
      borderStrong: '#93a1a1',
      text: '#073642',
      muted: '#657b83',
      accent: '#268bd2',
      accent2: '#2aa198',
      green: '#859900',
      red: '#dc322f',
      yellow: '#b58900',
      shadow: 'rgba(101,123,131,0.18)'
    }
  }
]

export function getTheme(id: string): ThemeDef {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0]
}

export function applyTheme(id: string): ThemeDef {
  const theme = getTheme(id)
  const root = document.documentElement
  root.dataset.theme = theme.id
  root.dataset.mode = theme.mode
  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty(`--${key}`, value)
  }
  return theme
}

export function monacoThemeDefinition(id: string): {
  base: 'vs' | 'vs-dark'
  inherit: boolean
  rules: { token: string; foreground?: string; fontStyle?: string }[]
  colors: Record<string, string>
} {
  const theme = getTheme(id)
  const hex = (value: string): string => value.replace('#', '')
  return {
    base: theme.mode === 'light' ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: hex(theme.colors.accent) },
      { token: 'keyword.sql', foreground: hex(theme.colors.accent) },
      { token: 'operator.sql', foreground: hex(theme.colors.accent2) },
      { token: 'string', foreground: hex(theme.colors.green) },
      { token: 'string.sql', foreground: hex(theme.colors.green) },
      { token: 'number', foreground: hex(theme.colors.yellow) },
      { token: 'comment', foreground: hex(theme.colors.muted), fontStyle: 'italic' },
      { token: 'predefined', foreground: hex(theme.colors.accent2) }
    ],
    colors: {
      'editor.background': theme.colors.bg,
      'editor.foreground': theme.colors.text,
      'editorLineNumber.foreground': theme.colors.muted,
      'editorLineNumber.activeForeground': theme.colors.accent,
      'editor.selectionBackground': theme.colors.surface2,
      'editor.inactiveSelectionBackground': theme.colors.surface,
      'editorCursor.foreground': theme.colors.accent,
      'editorIndentGuide.background1': theme.colors.border,
      'editorIndentGuide.activeBackground1': theme.colors.accent,
      'editorWidget.background': theme.colors.panel,
      'editorWidget.border': theme.colors.borderStrong,
      'editorSuggestWidget.background': theme.colors.panel,
      'editorSuggestWidget.border': theme.colors.borderStrong,
      'editorSuggestWidget.selectedBackground': theme.colors.surface2,
      'editorSuggestWidget.foreground': theme.colors.text,
      'editorHoverWidget.background': theme.colors.panel,
      'editorHoverWidget.border': theme.colors.borderStrong,
      'minimap.background': theme.colors.panel
    }
  }
}

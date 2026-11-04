/**
 * Sprout's light theme (`--sprout-*` in sprout/packages/sprout/src/styles/index.css) as sRGB hex. Sprout defines the
 * colours in OKLCH; Mermaid's `base` theme derives shades from hex, so these are the converted values. Update both
 * together when Sprout's palette changes.
 */
export const sproutLight = {
  canvas: '#f8f8f8',
  surface: '#fdfdfd',
  hover: '#ededed',
  active: '#e3e3e3',
  text: '#242424',
  muted: '#626262',
  line: '#e0e0e0',
  border: '#909090',
  borderStrong: '#707070',
  primary: '#262626',
  secondary: '#ececec',
  info: '#1f5fb8',
  infoSubtle: '#ebf1fd',
  success: '#1d6a37',
  successSubtle: '#e8f4eb',
  warning: '#8a4b08',
  warningSubtle: '#fdf1dc',
  danger: '#b32d34',
  dangerSubtle: '#fdeeef',
} as const;

export const sproutFont = 'ui-sans-serif, system-ui, sans-serif';
export const sproutMonoFont = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
export const sproutRadius = { control: '0.375rem', panel: '0.75rem' } as const;

export type MermaidConfig = {
  startOnLoad: false;
  securityLevel: 'strict';
  theme: 'base';
  fontFamily: string;
  themeVariables: Record<string, string>;
  flowchart: { htmlLabels: false; curve: 'basis'; padding: number; nodeSpacing: number; rankSpacing: number };
  sequence: { useMaxWidth: true; mirrorActors: false };
};

/** The `mermaid.initialize` config the render worker uses for every diagram in a plan document. */
export function planDocumentMermaidConfig(): MermaidConfig {
  const c = sproutLight;
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: sproutFont,
    themeVariables: {
      fontFamily: sproutFont,
      fontSize: '14px',
      background: c.surface,
      textColor: c.text,
      lineColor: c.muted,
      primaryColor: c.surface,
      primaryTextColor: c.text,
      primaryBorderColor: c.border,
      secondaryColor: c.secondary,
      secondaryTextColor: c.text,
      secondaryBorderColor: c.border,
      tertiaryColor: c.canvas,
      tertiaryTextColor: c.text,
      tertiaryBorderColor: c.line,
      mainBkg: c.surface,
      nodeBorder: c.border,
      nodeTextColor: c.text,
      clusterBkg: c.canvas,
      clusterBorder: c.line,
      titleColor: c.text,
      edgeLabelBackground: c.surface,
      actorBkg: c.surface,
      actorBorder: c.border,
      actorTextColor: c.text,
      actorLineColor: c.line,
      signalColor: c.muted,
      signalTextColor: c.text,
      labelBoxBkgColor: c.canvas,
      labelBoxBorderColor: c.line,
      labelTextColor: c.text,
      loopTextColor: c.text,
      activationBkgColor: c.hover,
      activationBorderColor: c.border,
      noteBkgColor: c.warningSubtle,
      noteBorderColor: c.warning,
      noteTextColor: c.text,
      stateBkg: c.surface,
      stateLabelColor: c.text,
      compositeBackground: c.canvas,
      compositeTitleBackground: c.hover,
      transitionColor: c.muted,
      cScale0: c.infoSubtle,
      cScale1: c.successSubtle,
      cScale2: c.warningSubtle,
      cScale3: c.secondary,
      cScaleLabel0: c.text,
      cScaleLabel1: c.text,
      cScaleLabel2: c.text,
      cScaleLabel3: c.text,
    },
    flowchart: { htmlLabels: false, curve: 'basis', padding: 12, nodeSpacing: 36, rankSpacing: 44 },
    sequence: { useMaxWidth: true, mirrorActors: false },
  };
}

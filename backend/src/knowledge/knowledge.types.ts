export type ChargerModel = 'Spin Air' | 'Tata/Compact';
export type LedPattern = 'solid' | 'blinking' | 'none';
export type LedSpeed = 'slow' | 'medium' | 'fast';

export interface ColourPattern {
  colour: string;
  pattern: string;
  speed?: string;
  speedMs?: number;
}

export interface LedStateEntry {
  state: string;
  spinAir: ColourPattern | null;
  tataCompact: ColourPattern | null;
  meaning: string;
  resolutionBranch: string;
}

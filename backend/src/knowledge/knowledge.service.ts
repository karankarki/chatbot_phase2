import { Injectable, Logger } from '@nestjs/common';
import * as ledMap from './led-map.json';
import * as faultTable from './faults.json';
import { ChargerModel, LedPattern, LedSpeed, LedStateEntry } from './knowledge.types';

interface LedMapJson {
  states: LedStateEntry[];
  neVoltageThresholds: {
    healthyMaxVolts: number;
    alarmIdleVolts: number;
    alarmChargingVolts: number;
  };
}

interface FaultEntry {
  alarm: string;
  led?: string;
  customerSteps?: string[];
  nocSteps?: string[];
  ticketTrigger?: string;
  severity?: 'Critical' | 'Major' | 'Minor';
}

@Injectable()
export class KnowledgeService {
  private readonly log = new Logger(KnowledgeService.name);

  getLedState(input: {
    model: ChargerModel;
    colour: string;
    pattern: LedPattern;
    speed?: LedSpeed;
  }): {
    state: string;
    meaning: string;
    resolutionBranch: string;
    matched: boolean;
    notes?: string;
  } {
    const colour = input.colour.toLowerCase();
    const pattern = input.pattern.toLowerCase();
    const speed = input.speed?.toLowerCase();

    const candidates = (ledMap as unknown as LedMapJson).states;
    for (const entry of candidates) {
      const cp = input.model === 'Spin Air' ? entry.spinAir : entry.tataCompact;
      if (!cp) continue;
      if (cp.colour !== colour) continue;
      if (cp.pattern !== pattern) continue;
      // Speed only matters when both sides specify it
      if (cp.speed && speed && cp.speed !== speed) continue;
      return {
        state: entry.state,
        meaning: entry.meaning,
        resolutionBranch: entry.resolutionBranch,
        matched: true,
      };
    }

    return {
      state: 'Unknown',
      meaning: 'No mapping found — ask the customer to narrow colour/pattern or upload a photo.',
      resolutionBranch: 'clarify-led',
      matched: false,
      notes: 'Never guess the LED state. Use a clarifying question or accept a photo.',
    };
  }

  getEarthBlinkMeaning(speedMs: number): string {
    if (speedMs <= 600) return 'NE Volt High';
    if (speedMs <= 1200) return 'Earth Detect / Open';
    return 'Earth Leakage';
  }

  getFaultResolution(alarmName: string): {
    alarm: string;
    found: boolean;
    led?: string;
    customerSteps?: string[];
    nocSteps?: string[];
    ticketTrigger?: string;
    severity?: 'Critical' | 'Major' | 'Minor';
  } {
    const norm = alarmName.replace(/[_\s-]+/g, ' ').trim().toLowerCase();
    for (const f of (faultTable as { faults: FaultEntry[] }).faults) {
      if (f.alarm.toLowerCase() === norm) {
        return { ...f, found: true };
      }
    }
    return { alarm: alarmName, found: false };
  }

  getNeVoltageThresholds(): LedMapJson['neVoltageThresholds'] {
    return (ledMap as unknown as LedMapJson).neVoltageThresholds;
  }
}

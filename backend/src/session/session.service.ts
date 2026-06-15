import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ChannelSurface, ChatMessage, ChatSession } from './session.types';

export type { ChannelSurface, ChatMessage, ChatSession };

@Injectable()
export class SessionService {
  private readonly sessions = new Map<string, ChatSession>();

  create(channel: ChannelSurface, prefill?: Partial<ChatSession['slots']>): ChatSession {
    const id = randomUUID();
    const now = Date.now();
    const session: ChatSession = {
      id,
      channel,
      createdAt: now,
      lastActivityAt: now,
      transcript: [],
      slots: { stepsTried: [], photos: [], ...prefill },
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): ChatSession {
    const s = this.sessions.get(id);
    if (!s) throw new NotFoundException(`Session ${id} not found`);
    return s;
  }

  append(id: string, msg: Omit<ChatMessage, 'ts'>): ChatSession {
    const s = this.get(id);
    s.transcript.push({ ...msg, ts: Date.now() });
    s.lastActivityAt = Date.now();
    return s;
  }

  updateSlots(id: string, slots: Partial<ChatSession['slots']>): ChatSession {
    const s = this.get(id);
    // Strip undefined values so they never overwrite existing slot data
    const defined = Object.fromEntries(
      Object.entries(slots).filter(([, v]) => v !== undefined),
    ) as Partial<ChatSession['slots']>;
    s.slots = { ...s.slots, ...defined };
    return s;
  }

  close(id: string, ticketId?: string): void {
    const s = this.get(id);
    s.slots.closed = true;
    if (ticketId) s.slots.ticketId = ticketId;
  }

  /** Sessions that have been silent for at least `idleMin` minutes. */
  idleSessions(idleMin: number): ChatSession[] {
    const cutoff = Date.now() - idleMin * 60_000;
    return [...this.sessions.values()].filter(
      (s) => !s.slots.closed && s.lastActivityAt < cutoff,
    );
  }
}

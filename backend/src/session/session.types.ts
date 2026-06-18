export type ChannelSurface = 'web-widget' | 'in-app';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  attachments?: string[];
  ts: number;
}

export interface ChargerSlot {
  index: number;
  serial: string;
  description: string;
  warrantyStatus: string;
  warrantyEndDate?: string;
}

export interface ChatSession {
  id: string;
  channel: ChannelSurface;
  createdAt: number;
  lastActivityAt: number;
  transcript: ChatMessage[];
  slots: {
    customerName?: string;
    mobile?: string;
    customerId?: string;
    circle?: string;
    /** All chargers returned by lookup — for multi-charger selection */
    chargers?: ChargerSlot[];
    /** Serial of the charger the customer is having an issue with */
    chargerSerial?: string;
    chargerDescription?: string;
    chargerModel?: 'Spin Air' | 'Tata/Compact';
    warrantyStatus?: string;
    warrantyEndDate?: string;
    /** true if an active ticket already exists for the selected charger */
    hasActiveTicket?: boolean;
    activeTicketNo?: string;
    activeTicketStatus?: string;
    /** true when this session was restored from a previous incomplete conversation */
    restored?: boolean;
    /** Ticket history for the selected charger — persisted so LLM can access it in any turn */
    recentTickets?: Array<{
      ticketNo: string;
      category: string;
      subCategory: string;
      status: string;
      ticketDate: string;
      timeline: Array<{
        stage: string;
        actionPerformedBy?: string;
        assignedTo?: string | null;
        notes?: string | null;
        createTime: string;
      }>;
    }>;
    ledState?: string;
    alarm?: string;
    stepsTried: string[];
    photos: string[];
    handoffRequested?: boolean;
    ticketId?: string;
    closed?: boolean;
    /** Previous conversation messages waiting for user to choose Continue vs Start New. Not yet in transcript. */
    pendingHistory?: Array<{ role: string; content: string }>;
  };
}

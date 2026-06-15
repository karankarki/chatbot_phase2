// ─── Real API shapes ──────────────────────────────────────────────────────────

export interface CrmChargerDetail {
  assetSerialNumber: string;
  assetID?: string;
  productFamily?: string;
  productRating?: string;
  description?: string;
  commissioningDate?: string;
  warrantyStartDate?: string;
  warrantyEndDate?: string;
  /** "Under Warranty" | "Expired" | "Not Started" */
  warrantyStatus: string;
  isCommissioned: boolean;
  partNumber?: string;
}

export interface CrmCustomerDetail {
  customerID: string;
  customerName: string;
  customerType?: string;
  contactNumber?: string;
  email?: string;
  circle?: string;
  accountName?: string;
}

export interface CustomerDetailResponse {
  data?: {
    customerDetail?: CrmCustomerDetail;
    chargerDetails?: CrmChargerDetail[];
  } | string;
  status: { code: number; message: string };
}

export interface TicketTimelineEntry {
  stage: string;
  actionPerformedBy?: string;
  assignedTo?: string | null;
  notes?: string | null;
  createTime: string;
}

export interface CrmTicket {
  id: string;
  ticketNo: string;
  callType: string;
  category: string;
  subCategory: string;
  ticketDate: string;
  pendingAt: string;
  timeline: TicketTimelineEntry[];
}

export interface TicketSummaryResponse {
  data?: { totalCount: number; tickets: CrmTicket[] } | string;
  status: { code: number; message: string };
}

export interface CategoryMapSubCategory {
  id: string;
  label: string;
  categoryId: string;
}

export interface CategoryMapCategory {
  id: string;
  label: string;
  subCategories: CategoryMapSubCategory[];
}

export interface CategoryMapCallType {
  id: string;
  label: string;
  categories: CategoryMapCategory[];
}

export interface CategoryMapResponse {
  success: boolean;
  code: number;
  data: CategoryMapCallType[];
}

export interface CrmCreateTicketPayload {
  callType: string;
  description: string;
  urgency?: 'High' | 'Medium' | 'Low';
  remarks?: string;
  category: { categoryId: string; subCategory: { subCategoryId: string }[] };
  customerInfo: { name: string; mobileNumber: string };
  assetInfo: { serialNumber: string; productCode?: string };
  attachments?: { name: string; url: string }[];
}

export interface CrmCreateTicketResponse {
  success: boolean;
  code: number;
  data?: { ticketId: string };
  errors?: Record<string, string>;
}

// ─── Internal (domain) shapes used by ToolRegistry ────────────────────────────

/** Simplified charger summary returned to the LLM */
export interface ChargerSummary {
  index: number;
  serial: string;
  description: string;
  warrantyStatus: string;
  warrantyEndDate?: string;
  isCommissioned: boolean;
}

/** Result returned by lookup_customer tool */
export interface CustomerLookup {
  found: boolean;
  customerId?: string;
  customerName?: string;
  contactNumber?: string;
  chargerCount?: number;
  chargers: ChargerSummary[];
  /** Set when chargerCount === 1 so the model knows no selection is needed */
  autoSelectedSerial?: string;
  /** Set when the CRM service itself failed (network/auth error) */
  serviceError?: boolean;
  serviceErrorMessage?: string;
}

/** Result returned by get_ticket_summary tool */
export interface TicketSummaryResult {
  serial: string;
  totalTicketCount: number;
  hasActiveTicket: boolean;
  activeTicketNo?: string;
  activeTicketStatus?: string;
  recentTickets: Array<{
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
  /** Set when the CRM service itself failed */
  serviceError?: boolean;
}

/** Ticket create result */
export interface TicketCreateResult {
  ticketId: string;
}

// ─── NOC Handoff ──────────────────────────────────────────────────────────────

export interface HandoffPayload {
  sessionId: string;
  transcriptRef?: string;
  context: {
    ledState?: string;
    alarm?: string;
    stepsTried?: string[];
    chargerSerial?: string;
    mobile?: string;
  };
}

export interface HandoffResult {
  handoffId: string;
  etaSeconds?: number;
  offline?: boolean;
}

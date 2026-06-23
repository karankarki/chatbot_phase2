import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { appendFileSync } from 'fs';
import {
  CategoryMapCallType,
  CategoryMapResponse,
  ChatHistoryFetchResponse,
  ChargerSummary,
  CrmCreateTicketPayload,
  CrmCreateTicketResponse,
  CrmTicket,
  CustomerDetailResponse,
  CustomerLookup,
  HandoffPayload,
  HandoffResult,
  TicketCreateResult,
  TicketSummaryResponse,
  TicketSummaryResult,
} from './crm.types';

/**
 * Thin client for the Exicom CRM/ticketing API.
 *
 * Auth: POST /api/auth/token  (clientId + clientSecret → JWT, cached 55 min)
 * Lookup: GET /api/spin-chat/get-details  (mobileNumber or serialNumber)
 * Ticket summary: GET /api/spin-chat/get/ticket-summary  (serialNumber)
 * Category map: GET /api/open-api/tickets/category-map  (cached 6 h)
 * Create ticket: POST /api/open-api/tickets
 */
@Injectable()
export class CrmClient {
  private readonly log = new Logger(CrmClient.name);
  private readonly base: string;
  private readonly clientId: string;
  private readonly clientSecret: string;

  private tokenCache: { token: string; expiresAt: number } | null = null;
  private categoryMapCache: CategoryMapCallType[] | null = null;
  private categoryMapFetchedAt = 0;
  private readonly CATEGORY_MAP_TTL = 6 * 60 * 60 * 1000;

  constructor() {
    const base = process.env.CRM_BASE_URL?.replace(/\/$/, '');
    if (!base) throw new Error('CRM_BASE_URL is required');
    this.base = base;
    this.clientId = process.env.CRM_CLIENT_ID ?? '';
    this.clientSecret = process.env.CRM_CLIENT_SECRET ?? '';
  }

  // ─── Auth ──────────────────────────────────────────────────────────────────

  private async getToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.token;
    }
    // Response shape: { status, data: { token, expiresIn } }  (expiresIn in ms)
    const { data: body } = await axios.post<{
      status: string;
      data: { token: string; expiresIn: number };
    }>(
      `${this.base}/api/auth/token`,
      { clientId: this.clientId, clientSecret: this.clientSecret },
      { timeout: 10_000 },
    );
    const { token, expiresIn } = body.data;
    this.tokenCache = { token, expiresAt: Date.now() + expiresIn - 60_000 };
    return token;
  }

  private async authHeaders() {
    const token = await this.getToken();
    return { Authorization: `Bearer ${token}` };
  }

  // ─── Customer lookup ────────────────────────────────────────────────────────

  async lookupByMobile(mobile: string): Promise<CustomerLookup> {
    try {
      const headers = await this.authHeaders();
      const { data } = await axios.get<CustomerDetailResponse>(
        `${this.base}/api/spin-chat/get-details`,
        { params: { mobileNumber: mobile }, headers, timeout: 10_000 },
      );
      return this.parseCustomerDetail(data);
    } catch (e) {
      return this.lookupError(e);
    }
  }

  async lookupBySerial(serial: string): Promise<CustomerLookup> {
    try {
      const headers = await this.authHeaders();
      const { data } = await axios.get<CustomerDetailResponse>(
        `${this.base}/api/spin-chat/get-details`,
        { params: { serialNumber: serial }, headers, timeout: 10_000 },
      );
      return this.parseCustomerDetail(data);
    } catch (e) {
      return this.lookupError(e);
    }
  }

  private parseCustomerDetail(res: CustomerDetailResponse): CustomerLookup {
    if (res.status.code !== 2000 || !res.data || typeof res.data === 'string') {
      return { found: false, chargers: [] };
    }
    const { customerDetail, chargerDetails = [] } = res.data as {
      customerDetail?: any;
      chargerDetails?: any[];
    };
    if (!customerDetail) return { found: false, chargers: [] };

    const chargers: ChargerSummary[] = chargerDetails.map((c, i) => ({
      index: i + 1,
      serial: c.assetSerialNumber,
      description: c.description ?? c.productFamily ?? 'AC Charger',
      warrantyStatus: c.warrantyStatus ?? 'Unknown',
      warrantyEndDate: c.warrantyEndDate,
      isCommissioned: c.isCommissioned ?? true,
    }));

    return {
      found: true,
      customerId: customerDetail.customerID,
      customerName: customerDetail.customerName,
      contactNumber: customerDetail.contactNumber || customerDetail.mobileNumber || customerDetail.mobile || '',
      circle: customerDetail.circle,
      chargerCount: chargers.length,
      chargers,
      autoSelectedSerial: chargers.length === 1 ? chargers[0].serial : undefined,
    };
  }

  private lookupError(e: unknown): CustomerLookup {
    const status = (e as AxiosError)?.response?.status;
    this.log.error(`Lookup failed (HTTP ${status ?? 'network'}): ${(e as Error).message}`);
    const msg = 'I was not able to look up that number right now. Please share the serial number printed on the sticker on your charger and I will help you from there.';
    return { found: false, chargers: [], serviceError: true, serviceErrorMessage: msg };
  }

  // ─── Ticket summary ─────────────────────────────────────────────────────────

  async getTicketSummary(serial: string): Promise<TicketSummaryResult> {
    try {
      const headers = await this.authHeaders();
      const { data } = await axios.get<TicketSummaryResponse>(
        `${this.base}/api/spin-chat/get/ticket-summary`,
        { params: { serialNumber: serial }, headers, timeout: 10_000 },
      );
      return this.parseTicketSummary(serial, data);
    } catch (e) {
      this.log.error(`getTicketSummary failed: ${(e as Error).message}`);
      return { serial, totalTicketCount: 0, hasActiveTicket: false, recentTickets: [], serviceError: true };
    }
  }

  private parseTicketSummary(serial: string, res: TicketSummaryResponse): TicketSummaryResult {
    if (res.status.code !== 2000 || !res.data || typeof res.data === 'string') {
      return { serial, totalTicketCount: 0, hasActiveTicket: false, recentTickets: [] };
    }
    const { totalCount, tickets } = res.data as { totalCount: number; tickets: CrmTicket[] };
    const CLOSED_STATUSES = new Set(['closed', 'cancelled', 'resolved', 'welcome call completed']);
    const CLOSED_STAGES   = new Set(['closure', 'cancelled', 'cancellation', 'resolved', 'resolution', 'welcome call completed']);
    // Ticket is closed if ticketStatus is a closed value, OR if any timeline stage signals closure
    const isClosed = (t: CrmTicket) =>
      !t.ticketStatus ||
      CLOSED_STATUSES.has(t.ticketStatus.toLowerCase()) ||
      t.timeline.some((e) => CLOSED_STAGES.has(e.stage.toLowerCase()));
    const isActive = (t: CrmTicket) => !isClosed(t);
    // Only Complaint-type tickets block new ticket creation — Query/others are ignored
    const activeComplaintTicket = tickets.find(
      (t) => t.callType?.toLowerCase() === 'complaint' && isActive(t),
    );

    return {
      serial,
      totalTicketCount: totalCount,
      hasActiveTicket: !!activeComplaintTicket,
      activeTicketNo: activeComplaintTicket?.ticketNo,
      activeTicketStatus: activeComplaintTicket?.ticketStatus,
      recentTickets: tickets.map((t) => ({
        ticketNo: t.ticketNo,
        category: t.category,
        subCategory: t.subCategory,
        status: t.ticketStatus,
        pendingAt: t.pendingAt,
        ticketDate: t.ticketDate.slice(0, 10),
        timeline: t.timeline.map((s) => ({
          stage: s.stage,
          ...(s.actionPerformedBy ? { actionPerformedBy: s.actionPerformedBy } : {}),
          ...(s.assignedTo        ? { assignedTo: s.assignedTo }               : {}),
          ...(s.notes             ? { notes: s.notes }                         : {}),
          createTime: s.createTime,
        })),
      })),
    };
  }

  // ─── Category map ───────────────────────────────────────────────────────────

  private async getCategoryMap(): Promise<CategoryMapCallType[]> {
    if (this.categoryMapCache && Date.now() - this.categoryMapFetchedAt < this.CATEGORY_MAP_TTL) {
      return this.categoryMapCache;
    }
    const headers = await this.authHeaders();
    const { data } = await axios.get<CategoryMapResponse>(
      `${this.base}/api/open-api/tickets/category-map`,
      { headers, timeout: 10_000 },
    );
    this.categoryMapCache = data.data;
    this.categoryMapFetchedAt = Date.now();
    return this.categoryMapCache;
  }

  async getCategoriesForDisplay(): Promise<Array<{ category: string; subCategories: string[] }>> {
    try {
      const map = await this.getCategoryMap();
      const complaintType = map.find((t) => t.label.toLowerCase().includes('complaint')) ?? map[0];
      if (!complaintType) return [];
      return complaintType.categories.map((c) => ({
        category: c.label,
        subCategories: c.subCategories.map((s) => s.label),
      }));
    } catch (e) {
      this.log.error(`getCategoriesForDisplay failed: ${(e as Error).message}`);
      return [];
    }
  }

  private async resolveCategory(
    categoryLabel: string,
    subCategoryLabel: string,
  ): Promise<{ categoryId: string; subCategoryId: string; categoryName: string; subCategoryName: string }> {
    const map = await this.getCategoryMap();
    const complaintType = map.find((t) => t.label.toLowerCase().includes('complaint')) ?? map[0];
    if (!complaintType) throw new Error('CRM category map is empty');

    const cl = categoryLabel.toLowerCase();
    const otherCategory = complaintType.categories.find((c) => c.label.toLowerCase() === 'other');
    const category =
      complaintType.categories.find((c) => c.label.toLowerCase() === cl) ??
      complaintType.categories.find((c) => c.label.toLowerCase().includes(cl)) ??
      otherCategory ??
      complaintType.categories[0];

    const sl = subCategoryLabel.toLowerCase();
    const otherSubCat = category.subCategories.find((s) => s.label.toLowerCase() === 'other');
    const subCat =
      category.subCategories.find((s) => s.label.toLowerCase() === sl) ??
      category.subCategories.find((s) => s.label.toLowerCase().includes(sl)) ??
      otherSubCat ??
      category.subCategories[0];

    this.log.log(
      `[resolveCategory] "${categoryLabel}" → "${category.label}" (${category.id}) | ` +
      `"${subCategoryLabel}" → "${subCat.label}" (${subCat.id})`,
    );

    return {
      categoryId: category.id,
      subCategoryId: subCat.id,
      categoryName: category.label,
      subCategoryName: subCat.label,
    };
  }

  // ─── Create ticket ──────────────────────────────────────────────────────────

  async createTicket(payload: {
    description: string;
    categoryLabel: string;
    subCategoryLabel: string;
    urgency?: 'High' | 'Medium' | 'Low';
    remarks?: string;
    customerName: string;
    mobileNumber: string;
    serialNumber: string;
    productCode?: string;
    locationState?: string;
    attachmentUrls?: string[];
  }): Promise<TicketCreateResult & { categoryName: string; subCategoryName: string }> {
    const { categoryId, subCategoryId, categoryName, subCategoryName } =
      await this.resolveCategory(payload.categoryLabel, payload.subCategoryLabel);

    const body: CrmCreateTicketPayload = {
      callType: 'Complaint',
      description: payload.description,
      urgency: payload.urgency ?? 'Medium',
      remarks: payload.remarks,
      category: { categoryId, subCategory: [{ subCategoryId }] },
      customerInfo: { name: payload.customerName, mobileNumber: payload.mobileNumber },
      assetInfo: { serialNumber: payload.serialNumber, productCode: payload.productCode },
      attachments: payload.attachmentUrls?.map((url) => ({
        name: url.split('/').pop() ?? 'file',
        url,
      })),
      ...(payload.locationState ? { location: { state: payload.locationState } } : {}),
    };

    const headers = await this.authHeaders();

    // Print the equivalent curl so it's visible in the terminal on every ticket hit
    const curlBlock =
      `\n─── CREATE TICKET CURL ───────────────────────────────────────\n` +
      `curl -s -X POST '${this.base}/api/open-api/tickets' \\\n` +
      `  -H 'Authorization: ${headers['Authorization']}' \\\n` +
      `  -H 'Content-Type: application/json' \\\n` +
      `  -d '${JSON.stringify(body, null, 2)}'\n` +
      `Resolved: category=${categoryName} (${body.category.categoryId}) | subCategory=${subCategoryName} (${body.category.subCategory[0].subCategoryId})\n` +
      `──────────────────────────────────────────────────────────────`;

    this.log.log(curlBlock);

    // Also append to a persistent debug log file
    try {
      appendFileSync(
        '/tmp/spinwise-ticket-debug.log',
        `[${new Date().toISOString()}]${curlBlock}\n\n`,
        'utf8',
      );
    } catch { /* non-fatal */ }


    const { data } = await axios.post<CrmCreateTicketResponse>(
      `${this.base}/api/open-api/tickets`,
      body,
      { headers: { ...headers, 'Content-Type': 'application/json' }, timeout: 15_000 },
    );

    if (!data.success || !data.data?.ticketId) {
      const errs = Object.values(data.errors ?? {}).join('; ');
      throw new Error(`Ticket creation failed: ${errs || 'unknown error'}`);
    }
    return { ticketId: data.data.ticketId, categoryName, subCategoryName };
  }

  // ─── Chat history ──────────────────────────────────────────────────────────

  async fetchChatHistory(phoneNo: string, serialNo: string): Promise<{
    found: boolean;
    messages?: Array<{ role: string; content: string }>;
    isClosed?: boolean;
  }> {
    try {
      const headers = await this.authHeaders();
      const { data } = await axios.get<ChatHistoryFetchResponse>(
        `${this.base}/api/spin-chat/chat-history`,
        { params: { mobileNumber: phoneNo, serialNumber: serialNo }, headers, timeout: 10_000 },
      );
      if (data.status?.code !== 2000 || !data.data || typeof data.data === 'string') {
        return { found: false };
      }
      const body = data.data as { conversation?: string; conversationText?: string };
      const raw  = body.conversation ?? body.conversationText ?? '';
      if (!raw) return { found: false };

      const isClosed = raw.includes('[END]');
      if (isClosed) return { found: true, isClosed: true };

      const cleaned = raw.replace(/\n\[END\]$/, '');
      const messages = JSON.parse(cleaned) as Array<{ role: string; content: string }>;
      return { found: true, messages, isClosed: false };
    } catch (e) {
      this.log.warn(`fetchChatHistory: ${(e as Error).message}`);
      return { found: false };
    }
  }

  async saveChatHistory(
    phoneNo: string,
    serialNo: string,
    messages: Array<{ role: string; content: string }>,
    closed = false,
  ): Promise<void> {
    try {
      const headers = await this.authHeaders();
      // Append [END] only for gracefully closed sessions so fetch can distinguish
      // a resumable (abandoned) conversation from a completed one.
      const conversation = JSON.stringify(messages) + (closed ? '\n[END]' : '');
      await axios.post(
        `${this.base}/api/spin-chat/chat-history`,
        { phoneNo, serialNo, conversation },
        { headers: { ...headers, 'Content-Type': 'application/json' }, timeout: 10_000 },
      );
      this.log.log(`[chatHistory] saved ${messages.length} msgs for ${phoneNo}/${serialNo} closed=${closed}`);
    } catch (e) {
      this.log.warn(`saveChatHistory: ${(e as Error).message}`);
    }
  }

  // ─── NOC handoff ───────────────────────────────────────────────────────────

  async requestHandoff(payload: HandoffPayload): Promise<HandoffResult> {
    const webhook = process.env.NOC_HANDOFF_WEBHOOK?.trim();
    if (!webhook) {
      this.log.warn('NOC_HANDOFF_WEBHOOK not set — returning offline handoff');
      return { handoffId: `H-${Date.now()}`, offline: true };
    }
    try {
      await axios.post(webhook, payload, { timeout: 5_000 });
      return { handoffId: `H-${Date.now()}`, etaSeconds: 120 };
    } catch (e) {
      this.log.error(`Handoff webhook failed: ${(e as Error).message}`);
      return { handoffId: `H-${Date.now()}`, offline: true };
    }
  }
}

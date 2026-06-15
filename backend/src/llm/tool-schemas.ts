import Anthropic from '@anthropic-ai/sdk';

/**
 * Anthropic tool-use schemas for the SpinWise agent — 4 tools.
 *
 * Removed tools (no longer LLM-facing):
 *   get_led_state, get_fault_resolution — inlined as TOON tables in the system prompt.
 *   get_open_tickets — replaced by get_ticket_summary after charger selection.
 *   check_warranty   — warrantyStatus/expiry returned inline by lookup_customer chargers[].
 *   close_session    — handled server-side via [END] sentinel in the assistant reply.
 *   get_ticket_categories — category map now embedded in system prompt (TICKET_CATEGORIES block).
 */
export const TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'lookup_customer',
    description:
      'Look up the customer by mobile number OR charger serial number. Returns customerName, chargers[] (each with serial, description, warrantyStatus, warrantyEndDate), chargerCount, and autoSelectedSerial (set only when chargerCount===1). Provide mobile first; if that returns found:false ask for the charger serial number and call again with serialNumber. After this call, if chargerCount>1 ask the customer which charger they need help with, then call get_ticket_summary with the selected serial.',
    input_schema: {
      type: 'object',
      properties: {
        mobile: {
          type: 'string',
          description: '10-digit Indian mobile number, optionally prefixed +91 / 91.',
        },
        serialNumber: {
          type: 'string',
          description: 'Charger serial number printed on the sticker on the back or side of the unit — use as fallback when mobile lookup returns found:false.',
        },
      },
    },
  },
  {
    name: 'get_ticket_summary',
    description:
      'Get ticket history and active-ticket status for a charger by serial number. Call this immediately after the customer selects (or auto-selects) a charger — before troubleshooting — to check for an existing open ticket and recent history. Returns totalTicketCount, hasActiveTicket, activeTicketNo, and a timeline summary of recent tickets.',
    input_schema: {
      type: 'object',
      properties: {
        serialNumber: {
          type: 'string',
          description: 'The charger serial number selected by or auto-selected for the customer.',
        },
      },
      required: ['serialNumber'],
    },
  },
  {
    name: 'request_noc_handoff',
    description:
      'Escalate to a live NOC engineer for remote diagnostics (live parameters, raw commands, Operative toggle, phase correction, EPO disable). Pass the full context the customer has shared so they do not have to repeat themselves. If NOC is offline, this returns offline:true and you should fall back to create_ticket.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        ledState: { type: 'string' },
        alarm: { type: 'string' },
        stepsTried: { type: 'array', items: { type: 'string' } },
      },
      required: ['reason'],
    },
  },
  {
    name: 'create_ticket',
    description:
      'Create a complaint ticket. Call get_ticket_categories first, pick the best category_name + sub_category_name from the returned labels, show the proposed ticket details to the customer for confirmation, then call this tool. Returns ticketId, categoryName, subCategoryName.',
    input_schema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Clear description of the issue including LED state, alarm name, and steps already tried.',
        },
        category_name: {
          type: 'string',
          description: 'Category label exactly as returned by get_ticket_categories (e.g. "Hardware").',
        },
        sub_category_name: {
          type: 'string',
          description: 'Sub-category label exactly as returned by get_ticket_categories (e.g. "LED Issue").',
        },
        urgency: {
          type: 'string',
          enum: ['High', 'Medium', 'Low'],
          description: 'High for safety/Critical issues; Medium for most hardware faults; Low for minor/app issues.',
        },
        noc_findings: { type: 'string' },
        recommended_engineer_action: { type: 'string' },
        photos_attachments: { type: 'array', items: { type: 'string' } },
        steps_already_tried: { type: 'array', items: { type: 'string' } },
        charges_consent: {
          type: 'boolean',
          description: 'TRUE when warranty is Active OR customer has explicitly consented to charges for Expired warranty.',
        },
      },
      required: ['description', 'category_name', 'sub_category_name', 'urgency', 'steps_already_tried', 'charges_consent'],
    },
  },
];

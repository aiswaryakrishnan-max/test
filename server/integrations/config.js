// All integration settings come from environment variables, read lazily so they can change in tests.
const env = (k, d = '') => (process.env[k] ?? d).trim();
const list = (k) => env(k).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const rawList = (k, sep = ',') => env(k).split(sep).map((s) => s.trim()).filter(Boolean);

export const config = {
  appUrl: () => env('APP_URL', `http://localhost:${env('PORT', '3000')}`).replace(/\/$/, ''),
  companyDomains: () => list('COMPANY_DOMAINS'),

  sso: () => ({
    issuer: env('OIDC_ISSUER').replace(/\/$/, ''),
    clientId: env('OIDC_CLIENT_ID'),
    clientSecret: env('OIDC_CLIENT_SECRET'),
    name: env('SSO_PROVIDER_NAME', 'SSO'),
    allowedDomains: list('SSO_ALLOWED_DOMAINS'),
    defaultTeam: env('SSO_DEFAULT_TEAM'),
    ssoOnly: env('SSO_ONLY') === 'true',
    get enabled() { return !!(this.issuer && this.clientId); },
  }),

  crm: () => ({
    provider: env('CRM_PROVIDER').toLowerCase(), // 'salesforce' | 'hubspot' | ''
    syncMinutes: Number(env('CRM_SYNC_MINUTES', '60')) || 60,
    hubspotToken: env('HUBSPOT_ACCESS_TOKEN'),
    hubspotBase: env('HUBSPOT_API_BASE', 'https://api.hubapi.com'),
    salesforceDomain: env('SALESFORCE_DOMAIN').replace(/\/$/, ''), // https://yourco.my.salesforce.com
    salesforceClientId: env('SALESFORCE_CLIENT_ID'),
    salesforceClientSecret: env('SALESFORCE_CLIENT_SECRET'),
    salesforceApiVersion: env('SALESFORCE_API_VERSION', 'v61.0'),
    // Win/loss fields for the Friday digest: API names of the deal fields in your CRM.
    // HubSpot has closed_won_reason / closed_lost_reason built in; everything else is usually custom.
    fields: {
      wonReason: env('CRM_WON_REASON_FIELD', env('CRM_PROVIDER').toLowerCase() === 'hubspot' ? 'closed_won_reason' : ''),
      lostReason: env('CRM_LOST_REASON_FIELD', env('CRM_PROVIDER').toLowerCase() === 'hubspot' ? 'closed_lost_reason' : ''),
      competitor: env('CRM_COMPETITOR_FIELD'),
      segment: env('CRM_SEGMENT_FIELD'),
      useCase: env('CRM_USE_CASE_FIELD'),
    },
  }),

  calendar: () => ({
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
    authUrl: env('GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth'),
    tokenUrl: env('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
    apiBase: env('GOOGLE_CALENDAR_API', 'https://www.googleapis.com/calendar/v3'),
    get enabled() { return !!(this.clientId && this.clientSecret); },
  }),

  chat: () => ({
    audience: env('GOOGLE_CHAT_AUDIENCE'),                       // project number, or the endpoint URL
    serviceAccount: env('GOOGLE_CHAT_SERVICE_ACCOUNT'),          // JSON key contents or a path to the file
    hour: Number(env('GOOGLE_CHAT_CHALLENGE_HOUR', '9')),
    apiBase: env('GOOGLE_CHAT_API', 'https://chat.googleapis.com/v1'),
    tokenUrl: env('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
    get enabled() { return !!this.audience; },
  }),

  // Daily GTM digest. Rotation lists and trackers are semicolon-separated; defaults are in server/digest/defaults.js.
  digest: () => ({
    sendTime: env('DIGEST_SEND_TIME', '08:30'),                 // each rep's local time, Mon-Fri
    approval: env('DIGEST_APPROVAL', 'all') === 'sensitive' ? 'sensitive' : 'all', // 'all' during the pilot
    pilotEmails: list('DIGEST_PILOT_EMAILS'),                   // empty = every rep linked in Chat
    webhookUrl: env('GOOGLE_CHAT_DIGEST_WEBHOOK'),               // optional: also post each day to a team space
    renderImages: env('DIGEST_RENDER_IMAGES', 'true') !== 'false',
    personas: rawList('DIGEST_PERSONAS', ';'),
    competitors: rawList('DIGEST_COMPETITORS', ';'),
    useCases: rawList('DIGEST_USE_CASES', ';'),
    referenceCustomers: list('DIGEST_REFERENCE_CUSTOMERS'),     // customers approved to be named
    minDealsForWeek: Number(env('DIGEST_MIN_CLOSED_DEALS', '3')) || 3,
    gong: {
      base: env('GONG_API_BASE', 'https://api.gong.io').replace(/\/$/, ''),
      accessKey: env('GONG_ACCESS_KEY'),
      secret: env('GONG_ACCESS_KEY_SECRET'),
      workspaceId: env('GONG_WORKSPACE_ID'),
      maxCalls: Number(env('GONG_MAX_CALLS', '200')) || 200,
      objectionTrackers: rawList('GONG_OBJECTION_TRACKERS', ';'),
      competitorTrackers: rawList('GONG_COMPETITOR_TRACKERS', ';'),
      get enabled() { return !!(this.accessKey && this.secret); },
    },
    drive: {
      approvedFolderId: env('GOOGLE_DRIVE_APPROVED_FOLDER_ID'),
      serviceAccount: env('GOOGLE_DRIVE_SERVICE_ACCOUNT') || env('GOOGLE_CHAT_SERVICE_ACCOUNT'),
      apiBase: env('GOOGLE_DRIVE_API', 'https://www.googleapis.com/drive/v3'),
      tokenUrl: env('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
      maxReviewAgeDays: Number(env('DIGEST_SOURCE_MAX_AGE_DAYS', '180')) || 180,
      get enabled() { return !!(this.approvedFolderId && this.serviceAccount); },
    },
    web: {
      domains: list('DIGEST_WEB_DOMAINS'),                       // human-picked news sources (required for web search)
      pages: rawList('DIGEST_WEB_PAGES'),                         // pages read every week, e.g. your what's-new page
      get enabled() { return this.domains.length > 0 || this.pages.length > 0; },
    },
  }),
};

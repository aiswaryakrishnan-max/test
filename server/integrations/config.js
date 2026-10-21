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

  digest: () => ({
    day: Number(env('DIGEST_DAY', '1')),                         // 1 = Monday … 7 = Sunday
    hour: Number(env('DIGEST_HOUR', '9')),
    lookbackDays: Number(env('DIGEST_LOOKBACK_DAYS', '7')) || 7,
    audience: env('DIGEST_AUDIENCE', 'the GTM team: AEs, SDRs, CSMs and sales engineers'),
    webhookUrl: env('GOOGLE_CHAT_DIGEST_WEBHOOK'),               // incoming webhook of the GTM space
    space: env('GOOGLE_CHAT_DIGEST_SPACE'),                      // or spaces/XXXX, posted by the PitchPulse Chat app
    gong: {
      base: env('GONG_API_BASE', 'https://api.gong.io').replace(/\/$/, ''),
      accessKey: env('GONG_ACCESS_KEY'),
      secret: env('GONG_ACCESS_KEY_SECRET'),
      workspaceId: env('GONG_WORKSPACE_ID'),
      maxCalls: Number(env('GONG_MAX_CALLS', '25')) || 25,
      get enabled() { return !!(this.accessKey && this.secret); },
    },
    drive: {
      folderIds: rawList('GOOGLE_DRIVE_FOLDER_IDS'),
      serviceAccount: env('GOOGLE_DRIVE_SERVICE_ACCOUNT') || env('GOOGLE_CHAT_SERVICE_ACCOUNT'),
      apiBase: env('GOOGLE_DRIVE_API', 'https://www.googleapis.com/drive/v3'),
      tokenUrl: env('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
      maxFiles: Number(env('GOOGLE_DRIVE_MAX_FILES', '10')) || 10,
      get enabled() { return !!(this.folderIds.length && this.serviceAccount); },
    },
    web: {
      topics: rawList('DIGEST_WEB_TOPICS', ';'),                 // e.g. "Competitor X pricing; AI in sales enablement"
      allowedDomains: list('DIGEST_WEB_DOMAINS'),
      get enabled() { return this.topics.length > 0; },
    },
    get enabled() { return !!(this.webhookUrl || this.space); },
  }),
};

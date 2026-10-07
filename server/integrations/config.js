// All integration settings come from environment variables, read lazily so they can change in tests.
const env = (k, d = '') => (process.env[k] ?? d).trim();
const list = (k) => env(k).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

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
};

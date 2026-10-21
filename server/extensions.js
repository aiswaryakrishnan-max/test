// Feature modules that register their own routes on the app.
import { registerRoleplays } from './roleplay.js';
import { registerSso } from './integrations/sso.js';
import { registerCrm } from './integrations/crm.js';
import { registerCalendar } from './integrations/calendar.js';
import { registerGoogleChat } from './integrations/googlechat.js';
import { registerDigest } from './integrations/digest.js';

export const extensions = [registerSso, registerCrm, registerCalendar, registerGoogleChat, registerDigest, registerRoleplays];

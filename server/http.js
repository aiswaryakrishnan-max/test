export function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

export function sessionCookie(token) {
  const secure = (process.env.APP_URL || '').startsWith('https://') ? '; Secure' : '';
  return `pp_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${14 * 86400}${secure}`;
}

export function isDebugEnabled(env = process.env) {
  const value = String(env.DEBUG || '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

/**
 * Ongoing registration / deposit dashboard API.
 * GET /api/ongoing — active payment windows with persistent countdowns.
 *
 * Auth: admin-only operations dashboard. Vendor sessions are blocked by the API guard.
 */

export function registerOngoingRoutes(app, { store }) {
  app.get('/api/ongoing', async (req, res) => {
    const ledgerUser = req.ledgerUser;
    const isAdmin = ledgerUser?.role === 'admin';
    const payload = await store.listOngoingWorkflows({
      staffName: null,
      isAdmin: true
    });
    res.json({
      ...payload,
      viewer: {
        role: ledgerUser?.role || 'admin',
        username: ledgerUser?.username || null,
        isAdmin
      }
    });
  });
}

/**
 * Ongoing registration / deposit dashboard API.
 * GET /api/ongoing — active payment windows with persistent countdowns.
 *
 * Auth: any logged-in ledger user (admin or staff), matching Contacts/Payments.
 * Staff filtering by assignee is applied only as soft preference: when a staff
 * user has assignments, they still see unassigned + their own; admins see all.
 */

export function registerOngoingRoutes(app, { store }) {
  app.get('/api/ongoing', async (req, res) => {
    const ledgerUser = req.ledgerUser;
    const isAdmin = ledgerUser?.role === 'admin';
    // Do not hide timers for staff — ops need full visibility like Payments.
    // Assignee metadata is still returned for each row.
    const payload = await store.listOngoingWorkflows({
      staffName: null,
      isAdmin: true
    });
    res.json({
      ...payload,
      viewer: {
        role: ledgerUser?.role || 'staff',
        username: ledgerUser?.username || null,
        isAdmin
      }
    });
  });
}

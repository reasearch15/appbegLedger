function vendorPayload(vendor) {
  return {
    id: vendor.id,
    vendorCode: vendor.vendor_code,
    vendor_code: vendor.vendor_code,
    name: vendor.name,
    status: vendor.status,
    commissionPercentage: vendor.commission_percentage,
    commission_percentage: vendor.commission_percentage,
    linkedStaffUid: vendor.linked_staff_uid,
    linked_staff_uid: vendor.linked_staff_uid,
    notes: vendor.notes,
    playerCount: vendor.player_count || 0,
    player_count: vendor.player_count || 0,
    created_at: vendor.created_at,
    updated_at: vendor.updated_at
  };
}

function vendorPlayerPayload(player) {
  return {
    id: player.id,
    vendorId: player.vendor_id,
    vendor_id: player.vendor_id,
    telegramContactId: player.telegram_contact_id,
    telegram_contact_id: player.telegram_contact_id,
    telegramName: player.telegram_name,
    telegram_name: player.telegram_name,
    telegramUsername: player.telegram_username,
    telegram_username: player.telegram_username,
    appbegUsername: player.appbeg_username,
    appbeg_username: player.appbeg_username,
    appbegPlayerUid: player.appbeg_player_uid,
    appbeg_player_uid: player.appbeg_player_uid,
    linked_at: player.linked_at,
    created_at: player.created_at,
    updated_at: player.updated_at
  };
}

function handleVendorError(res, error) {
  const status = error?.code === 'VALIDATION_ERROR' ? 400 : 400;
  res.status(status).json({ error: error.message || 'Vendor request failed.' });
}

export function registerVendorRoutes(app, { store, requireAdmin }) {
  const adminOnly = requireAdmin || ((_req, _res, next) => next());

  app.get('/api/vendors', adminOnly, async (_req, res) => {
    const vendors = await store.listVendors();
    res.json({ vendors: vendors.map(vendorPayload) });
  });

  app.get('/api/vendors/:id', adminOnly, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid vendor id.' });
    }
    const vendor = await store.getVendor(id);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found.' });
    const players = await store.listVendorPlayers(id);
    res.json({
      vendor: vendorPayload({ ...vendor, player_count: players.length }),
      players: players.map(vendorPlayerPayload)
    });
  });

  app.post('/api/vendors', adminOnly, async (req, res) => {
    try {
      const vendor = await store.createVendor({
        name: req.body?.name,
        commissionPercentage: req.body?.commissionPercentage,
        linkedStaffUid: req.body?.linkedStaffUid,
        notes: req.body?.notes
      });
      res.status(201).json({ vendor: vendorPayload(vendor) });
    } catch (error) {
      handleVendorError(res, error);
    }
  });
}

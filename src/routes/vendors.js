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
    created_at: vendor.created_at,
    updated_at: vendor.updated_at
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

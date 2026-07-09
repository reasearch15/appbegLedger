const CSV_COLUMNS = [
  ['uid', 'UID'],
  ['username', 'Username'],
  ['email', 'Email'],
  ['role', 'Role'],
  ['status', 'Status'],
  ['coadmin_uid', 'Coadmin UID'],
  ['created_by', 'Created By'],
  ['coin', 'Coin'],
  ['cash', 'Cash'],
  ['cash_box_npr', 'Cash Box NPR'],
  ['promo_locked_coins', 'Promo Locked Coins'],
  ['referral_bonus_coins', 'Referral Bonus Coins'],
  ['source', 'Source'],
  ['created_at', 'Created At'],
  ['updated_at', 'Updated At']
];

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function playersToCsv(players) {
  const header = CSV_COLUMNS.map(([, label]) => csvEscape(label)).join(',');
  const rows = players.map((player) => (
    CSV_COLUMNS.map(([key]) => csvEscape(player[key])).join(',')
  ));
  return [header, ...rows].join('\n');
}

function parseShowTestData(value) {
  return value === true || value === 'true' || value === '1';
}

export function registerAppBegPlayerRoutes(app, { appbegStore }) {
  app.get('/api/appbeg-players', async (req, res) => {
    if (!appbegStore.configured) {
      return res.status(503).json({
        configured: false,
        error: 'AppBeg database is not configured.'
      });
    }

    try {
      const format = String(req.query.format || '').toLowerCase();
      const showTestData = parseShowTestData(req.query.showTestData ?? req.query.show_test_data);
      const options = {
        page: req.query.page,
        limit: req.query.limit,
        query: req.query.query || req.query.q || '',
        sort: req.query.sort,
        dir: req.query.dir,
        status: req.query.status || '',
        coadmin: req.query.coadmin || '',
        showTestData
      };

      if (format === 'csv') {
        const players = await appbegStore.exportPlayersCsv(options);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="appbeg-players.csv"');
        return res.send(playersToCsv(players));
      }

      const [result, filters] = await Promise.all([
        appbegStore.listPlayers(options),
        appbegStore.getFilterOptions({ showTestData })
      ]);

      res.json({
        configured: true,
        ...result,
        filters
      });
    } catch (error) {
      console.error('[appbeg-players] list failed:', error);
      res.status(500).json({
        configured: true,
        error: error.message || 'Could not load AppBeg players.'
      });
    }
  });
}

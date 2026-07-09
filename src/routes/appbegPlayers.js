const CSV_COLUMNS = [
  ['display_name', 'Display Name'],
  ['player_uid', 'Player UID'],
  ['username', 'Username'],
  ['coadmin', 'Coadmin'],
  ['created_by', 'Created By'],
  ['source', 'Source'],
  ['coin_balance', 'Coin Balance'],
  ['cash_balance', 'Cash Balance'],
  ['npr_balance', 'NPR Balance'],
  ['game_usernames', 'Game Usernames'],
  ['game_names', 'Game Names'],
  ['status', 'Status'],
  ['last_activity', 'Last Activity'],
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
      const options = {
        page: req.query.page,
        limit: req.query.limit,
        query: req.query.query || req.query.q || '',
        sort: req.query.sort,
        dir: req.query.dir,
        status: req.query.status || '',
        coadmin: req.query.coadmin || ''
      };

      if (format === 'csv') {
        const players = await appbegStore.exportPlayersCsv(options);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="appbeg-players.csv"');
        return res.send(playersToCsv(players));
      }

      const [result, filters] = await Promise.all([
        appbegStore.listPlayers(options),
        appbegStore.getFilterOptions()
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

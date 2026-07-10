export function createQueryHelpers(dialect) {
  const isPostgres = dialect === 'postgres';

  const tagsJsonSelect = isPostgres
    ? `COALESCE((
        SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color))
        FROM telegram_user_tags ut
        JOIN tags t ON t.id = ut.tag_id
        WHERE ut.telegram_user_id = u.id
      ), '[]')`
  : `COALESCE((
        SELECT json_group_array(json_object('id', t.id, 'name', t.name, 'color', t.color))
        FROM telegram_user_tags ut
        JOIN tags t ON t.id = ut.tag_id
        WHERE ut.telegram_user_id = u.id
      ), '[]')`;

  const notesTextSelect = isPostgres
    ? `COALESCE((
        SELECT string_agg(note_text, ' ')
        FROM internal_notes
        WHERE telegram_user_id = u.id
      ), '')`
  : `COALESCE((
        SELECT group_concat(note_text, ' ')
        FROM internal_notes
        WHERE telegram_user_id = u.id
      ), '')`;

  const boolTrue = isPostgres ? 'TRUE' : '1';
  const boolFalse = isPostgres ? 'FALSE' : '0';

  function boolLiteral(value) {
    return value ? boolTrue : boolFalse;
  }

  function boolParam(value) {
    return isPostgres ? Boolean(value) : (value ? 1 : 0);
  }

  function messageUpsertSuffix() {
    return isPostgres
      ? ' ON CONFLICT (source, conversation_id, telegram_message_id, direction) WHERE telegram_message_id IS NOT NULL DO NOTHING'
      : '';
  }

  function insertOrIgnore(tableSql) {
    if (!isPostgres) return tableSql;
    return tableSql.replace(/INSERT OR IGNORE INTO/gi, 'INSERT INTO');
  }

  function quoteAlias(name) {
    return isPostgres ? `"${name}"` : name;
  }

  function datePrefixExpr(column) {
    return isPostgres
      ? `substring(${column} FROM 1 FOR 10)`
      : `substr(${column}, 1, 10)`;
  }

  return {
    isPostgres,
    boolTrue,
    boolFalse,
    boolLiteral,
    boolParam,
    tagsJsonSelect,
    notesTextSelect,
    messageUpsertSuffix,
    insertOrIgnore,
    quoteAlias,
    datePrefixExpr
  };
}

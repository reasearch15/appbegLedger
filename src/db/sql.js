export function convertPlaceholders(sql, params) {
  if (params && !Array.isArray(params) && typeof params === 'object') {
    const names = [];
    const convertedSql = sql.replace(/@([a-zA-Z_][\w]*)/g, (_, name) => {
      if (!names.includes(name)) names.push(name);
      return `$${names.indexOf(name) + 1}`;
    });
    return {
      sql: convertedSql,
      params: names.map((name) => params[name])
    };
  }

  const paramArray = Array.isArray(params)
    ? params
    : params === undefined || params === null
      ? []
      : [params];

  let index = 0;
  const convertedSql = sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });

  return {
    sql: convertedSql,
    params: paramArray
  };
}

export function sqliteDialectSql(sql) {
  return sql
    .replace(/NOW\(\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/BIGSERIAL/gi, 'INTEGER')
    .replace(/DOUBLE PRECISION/gi, 'REAL')
    .replace(/BOOLEAN/gi, 'INTEGER');
}

export function postgresDialectSql(sql) {
  return sql
    .replace(/INSERT OR IGNORE INTO/gi, 'INSERT INTO')
    .replace(/PRAGMA\s+[^;]+;/gi, '')
    .replace(/AUTOINCREMENT/gi, '')
    .replace(/substr\(/gi, 'substring(');
}

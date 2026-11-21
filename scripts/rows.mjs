export const meta = {
  purpose:
    "The rows of a data file that match a condition, with the number of all matches: 'who is on the night shift', 'the 5 highest paid', 'is there a row for WATCH-12', 'how many rows have an empty email'. Conditions are an object: {col: value} for equal, {col: {gt, gte, lt, lte, ne, in, contains, matches, empty}} for the rest, several columns for all of them, {or: [..]} for any of them.",
  params: {
    file: "path relative to the working folder, or a file name or part of one",
    where: 'the condition, e.g. {"rank": "Sergeant", "pay": {"gte": 30}}; text is compared exactly, numbers as numbers, contains ignores case, matches is a regular expression. Leave out for all rows',
    select: "columns to return, a list or comma-separated; default all (the first 40)",
    sort: "column to order by, '-column' for descending, or a list; empty cells go last",
    limit: "rows returned, default 20, at most 200. The count covers all matches",
    count: "false stops reading at the limit instead of counting all matches (faster on a large file; not with sort)",
    delimiter: "',', 'tab', ';' or '|' when the guess is wrong",
    header: "false when the first row is data",
    path: "for a JSON document, the array to read rows from",
  },
  returns: "{file, format, count, scanned, rows:[{_row, ...columns}], leftOut?, didYouMean?, notes?, verdict} or {file, error}. didYouMean: when nothing matched, the values of that column that differ only in capitals or contain the text. _row is the row's number in the file, 1 for the first data row. Cells of a CSV are text as written.",
  example: 'await scripts.run("rows", { file: "roster.csv", where: { shift: "night", rank: { in: ["Sergeant", "Captain"] } }, select: "name,post" })',
};

export default async function ({ data }, { file, where, select, sort, limit, count, delimiter, header, path }) {
  if (!file) throw new Error(`rows needs \`file\`; data files here: ${data.files().files.slice(0, 20).map((f) => f.path).join(", ") || "none"}`);
  const r = await data.rows(file, { where, select, sort, limit, count, delimiter, header, path });
  if (r.error) return r;
  if (r.count === 0 && where && typeof where === "object") {
    // Nothing matched: look for the value in another spelling, so the caller does not have to ask again.
    const near = {};
    for (const [col, want] of Object.entries(where)) {
      if (typeof want !== "string" || !want.trim()) continue;
      const v = await data.values(file, col, { top: 500, delimiter, header, path }).catch(() => null);
      if ((v?.values ?? []).some((x) => x.value === want)) continue;
      const w = want.trim().toLowerCase();
      const hits = (v?.values ?? []).filter((x) => typeof x.value === "string" && x.value !== "<redacted>" && (x.value.trim().toLowerCase() === w || x.value.toLowerCase().includes(w))).slice(0, 5);
      if (hits.length) near[v.column] = hits.map((x) => `${JSON.stringify(x.value)} (${x.count})`);
    }
    if (Object.keys(near).length) r.didYouMean = near;
  }
  r.verdict = r.count == null ? `${r.rows.length} rows shown; the matches were not counted` : where ? `${r.count} of ${r.scanned} rows match${r.leftOut ? `; ${r.rows.length} shown` : ""}` : `${r.scanned} rows; ${r.rows.length} shown`;
  return r;
}

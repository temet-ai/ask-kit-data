export const meta = {
  purpose:
    "How two data files differ: 'what changed between the April and May export', 'which rows were added or removed', 'are these two files the same'. With a key column rows are paired by it and the changed fields are listed with the old and new value; without a key whole rows are compared. The two files may have different formats (a CSV against a JSON file): values are compared as text.",
  params: {
    a: "the first (older) file",
    b: "the second (newer) file",
    key: "the column or columns that identify a row, optional but better; without it a changed row shows as one removed and one added",
    ignore: "columns to leave out of the comparison, e.g. a timestamp that changes on every row",
    limit: "rows listed under each of added, removed and changed, default 20, at most 100; the counts are exact",
  },
  returns: "{a, b, key, rowsA, rowsB, added, removed, changed?, unchanged, changedFields?:{column: rows}, addedRows, removedRows, changedRows?:[{<key>, changes:{column:{from, to}}}], columnsAdded?, columnsRemoved?, leftOut?, notes?, verdict} or {error}",
  example: 'await scripts.run("diff", { a: "payroll-april.csv", b: "payroll-may.csv", key: "badge", ignore: "paid_on" })',
};

export default async function ({ data }, { a, b, key, ignore, limit }) {
  if (!a || !b) throw new Error("diff needs two files: `a` (the older) and `b` (the newer)");
  const r = await data.diff(a, b, { key, ignore, limit });
  if (r.error) return r;
  const cols = (r.columnsAdded?.length ?? 0) + (r.columnsRemoved?.length ?? 0);
  const same = !r.added && !r.removed && !r.changed && !cols;
  r.verdict = same
    ? `the same ${r.rowsA} rows in both${r.ignored ? `, ignoring ${r.ignored.join(", ")}` : ""}`
    : `${r.added} added, ${r.removed} removed${r.changed != null ? `, ${r.changed} changed` : ""}, ${r.unchanged} unchanged${cols ? `; the columns differ too` : ""}`;
  return r;
}

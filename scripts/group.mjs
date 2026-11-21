export const meta = {
  purpose:
    "Counts and sums by group in a data file: 'how many officers per rank', 'total arrests by district', 'average pay by rank', 'incidents per day or month'. Groups by one or more columns, counts the rows, and adds sum, avg, min or max of named numeric columns. Sorted, with the top groups, the total and how many groups were left out.",
  params: {
    file: "path relative to the working folder, or a file name or part of one",
    by: "the column or columns to group by, a list or comma-separated",
    sum: "numeric columns to add up, optional",
    avg: "numeric columns to average, optional",
    min: "numeric columns to take the smallest of, optional",
    max: "numeric columns to take the largest of, optional",
    bucket: 'group an ISO date or timestamp column by its start: {"date": "month"} (year, month, day, hour, minute)',
    where: "only rows matching this condition (see the rows script), optional",
    sort: "'-count' (default), 'count', 'key' (the group's name, ascending), '-key', or an aggregate such as 'sum:pay' (largest first; '+sum:pay' for smallest first)",
    top: "groups returned, default 20, at most 200",
    delimiter: "',', 'tab', ';' or '|' when the guess is wrong",
    header: "false when the first row is data",
    path: "for a JSON document, the array to read rows from",
  },
  returns: "{file, by, total, groups, rows:[{<by columns>, count, sum_<col>?, avg_<col>?, min_<col>?, max_<col>?}], leftOut?, notes?, verdict} or {file, error}. A value not written as a number is left out of a sum and counted in notes.",
  example: 'await scripts.run("group", { file: "patrols.tsv", by: "district", sum: "arrests,incidents" })',
};

export default async function ({ data }, { file, by, sum, avg, min, max, bucket, where, sort, top, delimiter, header, path }) {
  if (!file) throw new Error(`group needs \`file\`; data files here: ${data.files().files.slice(0, 20).map((f) => f.path).join(", ") || "none"}`);
  const r = await data.group(file, { by, sum, avg, min, max, bucket, where, sort, top, delimiter, header, path });
  if (r.error) return r;
  const first = r.rows[0];
  r.verdict = first ? `${r.groups} groups over ${r.total} rows; first: ${r.by.map((c) => first[c] === "" ? "(empty)" : first[c]).join(" / ")} with ${first.count}` : `no rows${where ? " match the condition" : ""}`;
  return r;
}

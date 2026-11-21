export const meta = {
  purpose:
    "The distinct values of one column with how often each occurs, most frequent first: 'what statuses are there', 'which ranks exist', 'is the spelling consistent', 'is this column unique'. Run it before filtering on a value you have not seen.",
  params: {
    file: "path relative to the working folder, or a file name or part of one",
    column: "the column; exact name, or the same in another case, or a part of it",
    where: "only rows matching this condition (see the rows script), optional",
    top: "values returned, default 50, at most 500",
    delimiter: "',', 'tab', ';' or '|' when the guess is wrong",
    header: "false when the first row is data",
    path: "for a JSON document, the array to read rows from",
  },
  returns: "{file, column, rows, distinct, empty, values:[{value, count}], leftOut?, unique?, notes?, verdict} or {file, error}. distinct is exact up to 100000, then 'over 100000'.",
  example: 'await scripts.run("values", { file: "roster.csv", column: "rank" })',
};

export default async function ({ data }, { file, column, where, top, delimiter, header, path }) {
  if (!file) throw new Error(`values needs \`file\`; data files here: ${data.files().files.slice(0, 20).map((f) => f.path).join(", ") || "none"}`);
  const r = await data.values(file, column, { where, top, delimiter, header, path });
  if (r.error) return r;
  r.verdict = `${r.column} has ${r.distinct} distinct values in ${r.rows} rows${r.empty ? `, ${r.empty} empty` : ""}${r.unique ? "; every value occurs once" : ""}`;
  return r;
}

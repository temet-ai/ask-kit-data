export const meta = {
  purpose:
    "What is in a data file (CSV, TSV, JSON lines, JSON, gzip of these): how many rows, and for every column its type, how many cells are empty, how many distinct values, min and max, and the most frequent values. Also what is wrong with it: duplicate header names, ragged rows, mixed types, bad lines. Answers 'what columns does X have', 'how many rows', 'what does this file look like'.",
  params: {
    file: "path relative to the working folder, or a file name or part of one",
    columns: "only these columns, a list or comma-separated, optional",
    top: "most frequent values kept per column, default 5",
    full: "true reads every row of a file over 64 MB for the statistics; by default they come from the first 100000 rows and say so",
    delimiter: "for a delimited file when the guess is wrong: ',', 'tab', ';' or '|'",
    header: "false when the first row is data, not column names",
    path: "for a JSON document, the array to read rows from, e.g. 'watch.houses'; by default the largest array of objects",
  },
  returns:
    "{file, format, delimiter?, header?, path?, size, rows, columnCount, columns:[one line per column: 'name: type, N distinct, N empty, min, max, mean | max length, then top: value (count) | ... or e.g. three values'], sampled?, notes?, verdict} or {file, error}. data.profile(file) returns the same columns as objects.",
  example: 'await scripts.run("profile", { file: "roster.csv" })',
};

// One column as one line, so that a wide file stays a small result.
const line = (c) => {
  const parts = [c.type === "mixed" ? `mixed (${Object.entries(c.mixed).map(([k, n]) => `${n} ${k}`).join(", ")})` : c.type, `${c.distinct} distinct${c.unique ? " (every value once)" : ""}`, `${c.empty} empty`];
  if (c.redacted) parts.push("redacted");
  if (c.min !== undefined) parts.push(`min ${c.min}`, `max ${c.max}`);
  if (c.mean !== undefined) parts.push(`mean ${c.mean}`);
  if (c.maxLength !== undefined) parts.push(`max length ${c.maxLength}`);
  let s = `${c.name}: ${parts.join(", ")}`;
  if (c.top) s += `; top${c.topApprox ? " (among the first 10000 distinct values)" : ""}: ${c.top}`;
  else if (c.examples) s += `; e.g. ${c.examples}`;
  return s;
};

export default async function ({ data }, { file, columns, top, full, delimiter, header, path }) {
  if (!file) throw new Error(`profile needs \`file\`; data files here: ${data.files().files.slice(0, 20).map((f) => f.path).join(", ") || "none"}`);
  const r = await data.profile(file, { columns, top, full, delimiter, header, path });
  if (r.error) return r;
  const kinds = {};
  for (const c of r.columns) kinds[c.type] = (kinds[c.type] ?? 0) + 1;
  const problems = (r.notes ?? []).filter((n) => /^(duplicate|ragged|mixed|lines that|the file ends|the JSON document ends|elements that)/.test(n)).length;
  const { bytes, ...out } = r;
  out.columns = r.columns.map(line);
  out.verdict = `${r.file}: ${r.rows} rows, ${r.columnCount} columns (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ")})${r.sampled ? "; statistics from a sample" : ""}${problems ? `; ${problems} problem${problems === 1 ? "" : "s"} in notes` : ""}`;
  return out;
}

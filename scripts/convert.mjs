export const meta = {
  purpose:
    "Changes things: writes a new file that is a filtered or converted copy of a data file. 'Save the night shift as night.csv', 'convert incidents.jsonl to CSV', 'write the rows from May to a new file'. Rows go from file to file without being shown. Only works when the caller asked for a change (act).",
  params: {
    from: "the file to read",
    to: "the file to write; its extension gives the format (csv, tsv, jsonl, json, and .gz of these)",
    where: "only rows matching this condition (see the rows script), optional",
    select: "only these columns, a list or comma-separated, optional",
    limit: "at most this many rows, optional",
    format: "csv, tsv, jsonl or json when the name of `to` does not say",
    typed: "true writes the numbers, true, false and empty cells of a CSV as JSON values when writing JSON; by default they stay text",
    overwrite: "true replaces `to` when it exists, also when it is the file being read. Only when the caller asked for that",
  },
  returns: "{file, written, format, rows, columns, size, replaced, from, notes?, verdict} or {file, written: false, error}",
  example: 'await scripts.run("convert", { from: "roster.csv", to: "night.jsonl", where: { shift: "night" } })',
};

export default async function ({ data }, { from, to, where, select, limit, format, typed, overwrite }) {
  if (!from || !to) throw new Error("convert needs `from` (the file to read) and `to` (the file to write)");
  const r = await data.write(to, { from, where, select, limit }, { format, typed, overwrite });
  if (r.error) return r;
  r.verdict = `wrote ${r.rows} rows to ${r.file} (${r.format}, ${r.size})${r.replaced ? ", replacing the file that was there" : ""}`;
  return r;
}

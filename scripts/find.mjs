export const meta = {
  purpose:
    "Which data files there are, and which of them hold a column or a value: 'what data files are in this folder', 'which file has a column called badge', 'where does WATCH-12 appear'. With no column and no value it lists the data files with format and size. A value is a piece of text looked for in every cell, any case.",
  params: {
    column: "a column name or part of one, any case, optional",
    value: "text to look for in the cells (within the matched columns when column is given), optional",
    dir: "folder to look in, default the working folder; subfolders are included, hidden ones and node_modules are not",
  },
  returns: "with column or value: {dir, searched, files:[{file, format, size, columns?, rowsMatching?, inColumns?, firstRow?, example?}], unread?, note?, verdict}; with neither: {dir, count, files:['path (format, size)'], leftOut?, verdict} (the first 60)",
  example: 'await scripts.run("find", { value: "WATCH-12" })',
};

export default async function ({ data }, { column, value, dir }) {
  const has = (v) => v != null && v !== "";
  if (!has(column) && !has(value)) {
    const r = data.files(dir, { max: 60 });
    if (r.error) return r;
    r.files = r.files.map((f) => `${f.path} (${f.format}, ${f.size})`);
    r.verdict = r.count ? `${r.count} data files under ${r.dir}` : `no data files (csv, tsv, jsonl, json, parquet, xlsx, or .gz of these) under ${r.dir}`;
    return r;
  }
  const r = await data.find({ column, value, dir });
  if (r.error) return r;
  const what = [has(column) ? `a column like "${column}"` : null, has(value) ? `the value "${value}"` : null].filter(Boolean).join(" holding ");
  r.verdict = r.files.length ? `${r.files.length + (r.leftOut ?? 0)} of ${r.searched} data files have ${what}: ${r.files.slice(0, 5).map((f) => f.file).join(", ")}` : `none of the ${r.searched} data files under ${r.dir} has ${what}`;
  return r;
}

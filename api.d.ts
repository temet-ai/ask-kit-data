// A condition on rows. All keys must hold. Text is compared exactly (capitals included), a number as a number
// ("38.50" equals 38.5), contains ignores case, matches is a regular expression (any case), gt/gte/lt/lte compare
// numbers as numbers and everything else as text (ISO dates order correctly). null means empty.
// {rank: "Sergeant"}  {pay: {gte: 30, lt: 50}}  {rank: ["Sergeant", "Captain"]}  {notes: {empty: false}}
// {name: {contains: "vimes"}}  {or: [{shift: "night"}, {rank: "Captain"}]}
type Where = { [column: string]: string | number | boolean | null | (string | number)[] | { eq?: any; ne?: any; gt?: any; gte?: any; lt?: any; lte?: any; in?: any[]; contains?: string; matches?: string; empty?: boolean } } | { or: Where[] };

// How a file is read. All optional: the format, delimiter and header are detected, and said in the result.
interface ReadOpts {
  delimiter?: "," | "tab" | ";" | "|"; // a delimited file whose delimiter was guessed wrong
  header?: boolean; // false: the first row is data, and columns are named col1, col2, ...
  path?: string; // a JSON document: the array rows come from ("watch.houses", "watch.houses[].duty", "" for the top). Default: the largest array of objects not inside another array
  flatten?: boolean; // JSON rows: false keeps nested objects whole. Default true: {place: {street}} is the column "place.street"
}
// Every result starts with {file, format, delimiter?, header?, path?} and may hold notes: string[] (what was matched by
// substring, ragged rows, bad lines, redacted columns). An ordinary failure is {file, error}: no such file (the error lists
// the data files there are), not valid gzip, duckdb missing. Check `error` before using a result.
interface Described { file: string; format: string; delimiter?: string; header?: boolean; path?: string; notes?: string[]; error?: string }

declare const data: {
  workdir: string; // relative paths resolve against this folder
  duckdb: boolean; // true when the duckdb program is installed: Parquet and .xlsx files can be read, and data.sql works

  // A file is a path (relative to workdir, absolute, or ~/...), or a file name or part of one when it names one data file
  // under workdir ("roster" finds bench/roster.csv; the result says so in `matched`). A column is its exact name, the same
  // name in another case, or a part that fits one column only; the notes say which was used. An unknown column throws with the list.
  //
  // Formats: csv, tsv (RFC 4180 quoting, newlines inside quotes), jsonl / ndjson, json (an array of objects, or a document
  // holding one), and .gz of each. parquet and xlsx only when data.duckdb. Cells of a delimited file are text exactly as
  // written ("007", "1,200", "38.50"); JSON values keep their type. Nothing is converted.
  //
  // Redacted: a column whose name looks like a credential (password, token, secret, api key, ssn, card number) reads as
  // "<redacted>" everywhere; it can be counted and tested for empty, not compared. Files of credentials (.env, .npmrc,
  // *.pem, credentials.json, secrets.*) are refused. You do not need them.

  // Data files under a folder (default workdir), subfolders included; hidden folders, node_modules and JSON config files are skipped.
  files(dir?: string, o?: { max?: number }): { dir: string; count: number; files: { path: string; format: string; bytes: number; size: string }[]; leftOut?: number };

  // What a file holds. rows is exact. Per column: type (integer, number, boolean, date, timestamp, string, empty, mixed, array),
  // empty, distinct (a number, or "over 10000"), min/max/mean for numbers, min/max for dates, maxLength for text,
  // unique: true with examples when every value occurs once, else top: "value (count) | value (count)".
  // A file over 64 MB (16 MB gzipped) is profiled on its first 100000 rows and says so in `sampled`; full: true reads it all.
  profile(file: string, o?: ReadOpts & { columns?: string | string[]; top?: number; full?: boolean }): Promise<Described & { size: string; rows: number; columnCount: number; columns: any[]; sampled?: string }>;

  // Rows matching `where`, as objects with _row (the row's number in the file, from 1). count is all matches, rows the
  // first `limit` (default 20, at most 200) after sorting. sort: "pay", "-pay" or a list. count: false stops reading at
  // the limit (no count, no sort). Values are clipped at 200 characters.
  rows(file: string, o?: ReadOpts & { where?: Where; select?: string | string[]; sort?: string | string[]; limit?: number; count?: boolean }): Promise<Described & { count?: number; scanned?: number; rows: any[]; leftOut?: number }>;

  // Counts by group. rows: [{<by columns>, count, sum_pay, avg_pay, ...}], sorted by count unless sort says "key", "-key",
  // "sum:pay" (largest first) or "+sum:pay". bucket groups an ISO date column by its start. total is the rows counted,
  // groups the number of groups, leftOut what the top (default 20) cut. Values not written as numbers are left out of sums and counted in notes.
  group(file: string, o: ReadOpts & { by: string | string[]; sum?: string | string[]; avg?: string | string[]; min?: string | string[]; max?: string | string[]; bucket?: { [column: string]: "year" | "month" | "day" | "hour" | "minute" }; where?: Where; sort?: string; top?: number }): Promise<Described & { by: string[]; total: number; groups: number; rows: any[]; leftOut?: string }>;

  // The distinct values of one column, most frequent first.
  values(file: string, column: string, o?: ReadOpts & { where?: Where; top?: number }): Promise<Described & { column: string; rows: number; distinct: number | string; empty: number; values: { value: any; count: number }[]; leftOut?: number; unique?: boolean }>;

  // How two files differ. key (one column or several) pairs the rows: added, removed, changed (counts, exact), changedFields
  // {column: rows}, and addedRows, removedRows, changedRows [{<key>, changes: {column: {from, to}}}] (limit each, default 20).
  // Without key, whole rows are compared. ignore leaves columns out. The first file is held in memory: at most 300000 rows.
  diff(a: string, b: string, o?: { key?: string | string[]; ignore?: string | string[]; limit?: number; a?: ReadOpts; b?: ReadOpts }): Promise<any>;

  // Which data files under dir have a column like `column` (any case, substring), or `value` in a cell (any case, substring;
  // within the matched columns when both are given). Reads at most 200000 rows per file and stops after 40 s.
  find(o: { column?: string; value?: string; dir?: string }): Promise<{ dir: string; searched: number; files: any[]; leftOut?: number; unread?: string[]; note?: string }>;

  // The first rows as objects, for a look at the raw data: {columns, rows, complete}. limit default 20, at most 500.
  open(file: string, o?: ReadOpts & { limit?: number }): Promise<Described & { columns: string[]; rows: any[]; complete: boolean }>;

  // Call fn(row, n) for every row, streaming, for what the functions above cannot do. Return false from fn to stop.
  // Keep a counter or a small Map in fn; never collect all rows of a large file. Returns {columns, rows (the number read), stopped}.
  each(file: string, fn: (row: any, n: number) => boolean | void, o?: ReadOpts): Promise<Described & { columns: string[]; rows: number; stopped: boolean }>;

  // One SQL statement in duckdb (in-memory, run in workdir): sql("select rank, count(*) from 'roster.csv' group by 1").
  // Only when data.duckdb; otherwise it returns {error} with the install hint. Statements that read only (select, with, from,
  // describe, summarize, show, explain) unless the caller asked for a change. {columns, rows, total, complete}; at most max rows (default 200).
  sql(query: string, o?: { max?: number; timeoutMs?: number }): Promise<{ columns?: string[]; rows?: any[]; total?: number | string; complete?: boolean; error?: string }>;

  // Changes things: only in an ask where the caller asked for a change, otherwise it throws "not in this ask".
  // write("night.csv", rows) writes an array of objects. write("night.csv", {from: "roster.csv", where, select, limit}) writes a
  // filtered or converted copy, streamed from file to file (use this for anything large; redacted columns are copied as they
  // are in the source). The format comes from the name: csv, tsv, jsonl, json, and .gz of these. An existing file is replaced
  // only with overwrite: true, the file being read included. typed: true turns CSV numbers and booleans into JSON values.
  write(file: string, rows: any[] | { from: string; where?: Where; select?: string | string[]; limit?: number } & ReadOpts, o?: { format?: "csv" | "tsv" | "jsonl" | "json"; overwrite?: boolean; typed?: boolean; columns?: string | string[] }): Promise<{ file: string; written: boolean; format?: string; rows?: number; columns?: string[]; size?: string; replaced?: boolean; error?: string; notes?: string[] }>;
};

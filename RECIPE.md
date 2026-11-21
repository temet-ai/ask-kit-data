# Recipe: the data kit

## What it answers

What a data file holds: its columns and their types, how many rows, which values a column takes, which rows match a condition, counts, sums and averages by group, how two files differ, which file in the folder has a column or a value. It also acts: it writes a filtered or converted copy of a file.

## What it needs

- Node.js 22.13 or newer. No packages.
- ask-kit with kit support (`min_ask_kit = "0.3.0"`).
- One setting, `WORKDIR`, detected as the folder the agent runs in. No tokens.
- Optional: the `duckdb` program on PATH, for Parquet and `.xlsx` files and for `data.sql`. It is not in `requires`; without it those calls return an error with the install hint.

## What it reads and runs

It reads files under `WORKDIR` (or a path the caller gives) with `node:fs`, `node:zlib` and its own parsers, as a stream. It runs no program, except `duckdb -jsonlines -c <statement>` (no shell) for Parquet, Excel and `data.sql` when `duckdb` is installed. It writes only through `data.write`, to a temporary file that is then renamed.

Formats: CSV and TSV with RFC 4180 quoting, newlines inside quoted cells, a byte order mark (UTF-8 or UTF-16), the delimiter sniffed from comma, tab, semicolon and pipe, and the header detected (a first row of text only), with `delimiter` and `header: false` to override. JSON lines. JSON: a top-level array, or the largest array of objects that is not inside another array, with the path said in the result and `path` to pick another. Gzip of each.

Refused or hidden because answers go to a cloud model: files named like credentials (`.env`, `.npmrc`, `.netrc`, key files, `credentials.*`, `secrets.*`, `.ssh/`, `.aws/`); the values of columns named like credentials (password, token, secret, api key, ssn, card number), which read as `<redacted>`, cannot be filtered on or summed, and show in a diff only as changed; passwords in URLs and private key blocks in any cell; in `data.sql`, `getenv`, stored secrets and credential files.

Bounded: profile statistics come from the first 100000 rows of a file over 64 MB (16 MB gzipped) while rows are counted exactly; distinct values are exact up to 10000 per column in a profile and 100000 in `values` and `group`; `diff` holds at most 300000 rows of the first file; `find` reads at most 200000 rows of each of 400 files and stops after 40 s; a read stops after 100 s; row lists hold 20 rows by default and 200 at most; cells are clipped at 200 characters.

## Brief to rebuild it from an empty folder

Make a folder with `ask-kit.toml` (id `temet.data`, name `data`, `says`, `keywords`, `route_hint`, `cite`, `acts = ["data.write"]`, a `[[settings]]` entry `WORKDIR` with `detect = ["node", "-e", "process.stdout.write(process.cwd())"]`, one `[[sources]]` of kind `module`, name `data`, module `data.mjs`, api `api.d.ts`, `instructions = "instructions.md"`, and two reading `[[actions]]`: `files` on the `find` script for "what data files are here", `columns` on the `profile` script for "what columns does X have" and "how many rows are in X").

`data.mjs` exports `make({settings, push, act})` returning the `data` global. Inside: a streaming CSV parser (a state machine over chunks of text that calls back with each record), a JSON lines parser, and a JSON scanner that walks a document character by character, tracks the path of every array, and either counts the objects in each array or parses the elements of one target array one at a time. `prepare(file)` locates the file (the path, or a data file whose name matches: exact, then without extension, then substring), refuses credential files, reads the first 256000 characters to settle the format, delimiter, header and columns, and caches that. `scan(prepared, opts, onRow)` streams rows: arrays of cells for delimited files, flattened objects (dotted keys, four levels) for JSON, with secret columns replaced unless the internal `raw` flag is set. On top of `scan`: `profile` (types per cell: integer, number, boolean, date, timestamp, string, empty; a number only when written as one, so "007", "1,200" and "$5" stay text), `rows` (a `where` object compiled to a test; sort keeps only the best `limit` rows; `count: false` stops early), `group`, `values`, `diff` (the first file in a Map by key, the second streamed against it), `find`, `open`, `each`, and `files` (a walk bounded to 6 levels and 20000 entries, skipping hidden folders, `node_modules` and well-known JSON config names). `sql` runs duckdb and refuses statements that write unless `act`. `write` is replaced by the real function only when `act` is true; otherwise it throws `not in this ask: ...`. Ordinary failures (no such file, bad gzip, duckdb missing) are returned as `{file, error}`; only refusals, missing params and unknown names throw, and the message names what exists.

Scripts in `scripts/` (each `export const meta = {purpose, params, returns, example}` and `export default async function ({data}, params)`): `profile` (one line per column, problems in notes, a verdict), `rows` (matches with `_row` numbers and the count; when nothing matches, the near spellings of the value), `group`, `values`, `diff`, `find` (with no params, the list of data files), `convert` (acts: `data.write` from file to file).

`instructions.md` has the same structure as the docker kit's: how to work (scripts first, never guess a file, column or value, run `values` before filtering, cells of a CSV are text, read the notes, say when statistics are sampled, how to decide unique, duplicates, clean and same, redaction and why, duckdb missing, acting), and the answer format (answer first, cite file, column and row number or count).

`bench/questions.json` holds only `do` questions, run against `bench/fixture/` (Discworld data: a Watch duty roster as CSV with quoted commas and a newline inside a cell, patrol reports as TSV, incidents as JSON lines, the Watch houses as nested JSON, arrests as gzipped semicolon CSV, two payroll exports with a `password` column). Run `ask-kit kit test data` from the kit's folder, because relative paths resolve against `WORKDIR`. Model questions (`q`) are still to be added, from real sessions in which an agent inspected a data file by hand; ask-kit's rule is that they are never invented.

## Results

ask-kit `kit test` on 2026-11-20: 19/19 shots, all answered with no model. No model run has been made. On a generated 200 MB CSV of 2.2 million rows: `profile` 1.4 s (4.8 s with `full: true`), `rows` with a full count 1.3 s, `rows` stopping early under 0.1 s, peak memory 57 to 175 MB. The duckdb path is unverified.

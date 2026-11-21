# ask-kit-data

An [ask-kit](https://github.com/temet-ai/ask-kit) kit that lets your coding agent's `ask` tool
answer questions about the data files in your folder: CSV, TSV, JSON lines, JSON, and gzip of
these. A cheap model streams the file outside your agent's context and answers with columns,
counts and row numbers, so your agent does not pull thousands of rows in with `head`, `jq` or a
throwaway script.

Questions it is built for:

- What columns does roster.csv have, what types are they, and how many rows are there?
- Which officers are on the night shift, and how many arrests did each district have in May?
- What changed between payroll-april.csv and payroll-may.csv?

## Install

You need [ask-kit](https://github.com/temet-ai/ask-kit#set-it-up) and Node.js 22.13 or newer. The
kit has no dependencies. Parquet and Excel (`.xlsx`) files are read only when the
[`duckdb`](https://duckdb.org/docs/installation) program is on PATH; without it the kit says so
and everything else works.

Paste this into your agent:

```
Read ~/.config/ask-kit/AGENTS.md, then add this kit: github.com/temet-ai/ask-kit-data
```

Or run it yourself:

```sh
ask-kit kit install temet-ai/ask-kit-data        # shows what it reads, changes and runs
ask-kit kit install temet-ai/ask-kit-data --yes  # installs and enables it
```

Restart your agents so `ask` lists `data`. `ask-kit kit list` says whether it can run on this
machine, and why not. The kit has one setting, `WORKDIR`, the folder questions are about; it is
detected as the folder your agent runs in.

## What it can change

When asked, it writes one new file: a filtered or converted copy of a data file, or a small set
of rows (`data.write`, and the `convert` script). It writes CSV, TSV, JSON lines and JSON, gzipped
when the name ends in `.gz`. It never replaces an existing file, the file it reads included,
unless the request says to. With `duckdb` installed and a request that asks for a change,
`data.sql` also runs statements that write.

`data.mjs` guards what the model reads:

- Columns whose names look like credentials (password, token, secret, api key, ssn, card number)
  read as `<redacted>` in every result. A profile gives their type and counts only, and a filter
  on their values is refused. What the investigator reads goes to a model.
- Files of credentials are refused by name: `.env`, `.npmrc`, `.netrc`, key files, `credentials.*`,
  `secrets.*`, and anything under `.ssh` or `.aws`.
- Passwords inside URLs and private key blocks are hidden in any cell.
- Everything is bounded: lists are capped and say how many were left out, cells are clipped at 200
  characters, a read stops after 100 seconds.

## How well it works

The bench, `bench/questions.json`, holds 19 shots: a script and its params, run with no model
against the files in `bench/fixture/`. `ask-kit kit test data` on 2026-11-20 passed 19 of 19, all
answered with no model. That checks the scripts, not an investigator: no model run has been made
yet, and the bench has no model questions, because those come only from real sessions.

On a generated 200 MB CSV (2.2 million rows, 9 columns, newlines inside quoted cells) on one Linux
machine: `profile` took 1.4 s, about 1.6 million rows a second, with the row count exact and the
statistics from the first 100000 rows; with `full: true` it took 4.8 s. A `rows` query with a
count of all matches took 1.3 s, and with `count: false` it stopped after 20 matches in under
0.1 s. Peak memory was 150 to 175 MB for the full reads and 57 MB for the early stop. The counts
matched Python's `csv` module.

The `duckdb` path (Parquet, Excel, `data.sql`) was written without `duckdb` on the machine. It
was run against a stand-in program only, so treat it as unverified.

## What is in it

`data.mjs` gives the investigator a `data` global that streams files: `profile`, `rows`, `group`,
`values`, `diff`, `find`, `files`, `open`, `each`, `sql`, and `write` when the caller asked for a
change. Its scripts are `profile` (rows, columns, types, empty and distinct counts, problems in
the file), `rows` (the rows matching a condition, with the count of all matches), `group` (counts,
sums and averages by column), `values` (the distinct values of a column), `diff` (added, removed
and changed rows between two files), `find` (which data files exist, and which holds a column or
a value) and `convert` (write a filtered or converted copy). [RECIPE.md](RECIPE.md) says what it
reads and runs, and how to rebuild it.

MIT licence.

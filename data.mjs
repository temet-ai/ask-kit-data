// Data files for ask-kit: CSV, TSV, JSON lines, JSON and gzip of these, read in pure Node; Parquet
// and Excel through the `duckdb` program when it is on PATH. The global answers about a file: its
// columns and types, its row count, the values of a column, the rows that match a condition, counts
// and sums by group, how two files differ. With act it writes a filtered or converted copy.
//
// Three rules shape the code. Files are streamed: nothing reads a whole large file into memory,
// and a read stops as soon as the answer is known. Results are small: lists are capped and say how
// many were left out, long values are clipped. And answers go to a cloud model, so columns whose
// names look like credentials are shown as <redacted>, and files that hold credentials are refused.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const LARGE = 64 << 20; // above this, profile takes its statistics from a sample
const LARGE_GZ = 16 << 20;
const SAMPLE = 100_000; // rows in that sample
const DISTINCT_CAP = 10_000; // distinct values tracked per column in a profile
const GROUP_CAP = 100_000; // groups, or distinct values, held in memory by group() and values()
const DIFF_CAP = 300_000; // rows of the first file held in memory by diff()
const HEAD_CHARS = 256_000; // text read to sniff the format, the delimiter and the header
const ONE_DOC_MAX = 32 << 20; // a JSON document with no array of objects is read whole up to this
const TIMEOUT_MS = 100_000;
const CLIP = 200;
const REDACTED = "<redacted>";
const SKIP_DIRS = new Set(["node_modules", "venv", "__pycache__", "site-packages", "bower_components", "vendor"]);
const CONFIG_JSON = /^(package(-lock)?|tsconfig.*|jsconfig.*|composer(\.lock)?|\.?eslintrc.*|\.?prettierrc.*|manifest|launch|settings|tasks|extensions|devcontainer|renovate|firebase|vercel|now|lerna|nx|turbo|biome|deno|bun\.lock|angular|app|babel\.config|components)\.json$/i;

const deny = (why) => {
  throw new Error(`not allowed: ${why}`);
};

// Files that hold credentials. Their content would go to a cloud model, so they are never opened.
const SECRET_FILE = /(^|[\\/])(\.env(\.[^\\/]*)?|\.npmrc|\.netrc|\.pgpass|\.git-credentials|\.htpasswd|id_(rsa|dsa|ecdsa|ed25519)[^\\/]*|credentials?(\.[^\\/]*)?|secrets?(\.[^\\/]*)?|[^\\/]*\.(pem|key|p12|pfx|keystore|jks|kdbx))(\.gz)?$|(^|[\\/])\.(ssh|aws|gnupg|kube|docker)[\\/]/i;

// Column names whose values are never shown: password, token, secret, api key, ssn, card number and the like.
const SECRET_WORD = /^pass(code)?$|passw(or)?d|passphrase|^pwd$|^pw$|secret|token|api ?key|access ?key|private ?key|secret ?key|credential|^ssn$|social ?security|(card|cc|pan) ?(number|num|no)$|^cvv$|^cvc$|^pin$|^otp$|authorization|^auth$|cookie|bearer/;
const secretCache = new Map();
/** True when a column name looks like it holds a credential. Each part of a dotted name is checked. */
export function isSecretName(name) {
  const key = String(name);
  let v = secretCache.get(key);
  if (v === undefined) {
    v = key.split(".").some((part) => {
      const words = part
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_\-\s]+/g, " ")
        .trim()
        .toLowerCase();
      return SECRET_WORD.test(words) || words.split(" ").some((w) => SECRET_WORD.test(w));
    });
    if (secretCache.size < 5000) secretCache.set(key, v);
  }
  return v;
}

// ---- values ----

const INT = /^-?(?:0|[1-9]\d{0,14})$/;
const DEC = /^-?(?:0|[1-9]\d*)\.\d+$|^-?(?:0|[1-9]\d*)(?:\.\d+)?[eE][+-]?\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/** The type of one cell: integer, number, boolean, date, timestamp, string, empty (and array, object for JSON values). */
export function typeOf(v) {
  if (v == null || v === "") return "empty";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v !== "string") return Array.isArray(v) ? "array" : "object";
  const c = v.charCodeAt(0);
  if ((c >= 48 && c <= 57) || c === 45) {
    if (v.length > 40) return "string";
    if (INT.test(v)) return "integer";
    if (DEC.test(v)) return "number";
    if (v.length === 10 && DATE.test(v)) return "date";
    if (v.length >= 16 && STAMP.test(v)) return "timestamp";
    return "string";
  }
  if (v.length <= 5 && (c === 116 || c === 102 || c === 84 || c === 70) && /^(true|false)$/i.test(v)) return "boolean";
  return "string";
}

// A number only when it is written as one: 12, -3.5, 1e6. "007", "1,200" and "$5" stay strings.
const num = (v) => {
  if (typeof v === "number") return v;
  if (typeof v !== "string" || v.length > 40 || v === "") return NaN;
  const c = v.charCodeAt(0);
  if (!((c >= 48 && c <= 57) || c === 45)) return NaN;
  return INT.test(v) || DEC.test(v) ? Number(v) : NaN;
};
const isEmpty = (v) => v == null || v === "";
const text = (v) => (v == null ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v));
const tidy = (x) => (Number.isFinite(x) ? Number(x.toPrecision(15)) : null);
const human = (b) => (b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : b >= 2 ** 20 ? `${(b / 2 ** 20).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`);

const scrub = (s) =>
  s
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]*):[^\s/@]+@/gi, `$1:${REDACTED}@`)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED);
const clip = (s, n = CLIP) => (s.length > n + 20 ? `${s.slice(0, n)}… [+${s.length - n} chars]` : s);
/** A value as it is shown: long text clipped, passwords in URLs and private keys hidden, nested secret keys redacted. */
export function show(v, n = CLIP) {
  if (v == null) return v === undefined ? "" : null;
  if (typeof v === "string") return clip(scrub(v), n);
  if (typeof v === "object") return clip(scrub(JSON.stringify(v, (k, x) => (k && isSecretName(k) && x != null && x !== "" ? REDACTED : x))), n);
  return v;
}

function flatten(o, prefix, out, depth) {
  for (const k in o) {
    const v = o[k];
    const name = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && depth < 4 && !isSecretName(k)) {
      let any = false;
      for (const _ in v) {
        any = true;
        break;
      }
      if (any) {
        flatten(v, name, out, depth + 1);
        continue;
      }
    }
    out[name] = v;
  }
  return out;
}

// ---- parsers ----

// RFC 4180 records from chunks of text: quoted fields, doubled quotes, newlines inside quotes, CRLF.
// A quote that is not at the start of a field is kept as text. Blank lines are skipped.
export function csvParser(delim, onRow) {
  const D = delim.charCodeAt(0);
  let row = [];
  let field = "";
  let inQ = false;
  let afterQ = false;
  let started = false;
  let lastCR = false;
  let stop = false;
  const endRow = () => {
    row.push(field);
    field = "";
    started = false;
    const r = row;
    row = [];
    if (r.length === 1 && r[0] === "") return;
    if (onRow(r) === false) stop = true;
  };
  return {
    write(s) {
      const n = s.length;
      let i = 0;
      while (i < n) {
        if (inQ) {
          if (afterQ) {
            afterQ = false;
            if (s.charCodeAt(i) === 34) {
              field += '"';
              i++;
            } else inQ = false;
            continue;
          }
          const j = s.indexOf('"', i);
          if (j < 0) {
            field += s.slice(i);
            break;
          }
          field += s.slice(i, j);
          i = j + 1;
          afterQ = true;
          continue;
        }
        const c0 = s.charCodeAt(i);
        if (lastCR) {
          lastCR = false;
          if (c0 === 10) {
            i++;
            continue;
          }
        }
        if (c0 === 34 && !started) {
          inQ = true;
          started = true;
          i++;
          continue;
        }
        let j = i;
        for (; j < n; j++) {
          const c = s.charCodeAt(j);
          if (c === D || c === 10 || c === 13) break;
        }
        if (j > i) {
          field = field === "" ? s.slice(i, j) : field + s.slice(i, j);
          started = true;
        }
        if (j === n) break;
        const c = s.charCodeAt(j);
        i = j + 1;
        if (c === D) {
          row.push(field);
          field = "";
          started = false;
        } else {
          if (c === 13) lastCR = true;
          endRow();
          if (stop) return false;
        }
      }
      return true;
    },
    end() {
      const unterminated = inQ && !afterQ;
      inQ = false;
      if (field !== "" || row.length || started) endRow();
      return { unterminated };
    },
  };
}

// Lines of JSON from chunks of text. A line that does not parse is counted, not thrown.
export function linesParser(onValue, stats) {
  let rest = "";
  let line = 0;
  let stop = false;
  const one = (l) => {
    line++;
    if (l.length < 2 && !l.trim()) return;
    let v;
    try {
      v = JSON.parse(l);
    } catch {
      if (!l.trim()) return;
      stats.badLines = (stats.badLines ?? 0) + 1;
      stats.firstBadLine ??= line;
      return;
    }
    if (onValue(v) === false) stop = true;
  };
  return {
    write(s) {
      let from = 0;
      for (;;) {
        const j = s.indexOf("\n", from);
        if (j < 0) break;
        one(rest ? rest + s.slice(from, j) : s.slice(from, j));
        rest = "";
        from = j + 1;
        if (stop) return false;
      }
      rest += s.slice(from);
      return true;
    },
    end() {
      if (rest.trim()) one(rest);
      rest = "";
      return {};
    },
  };
}

// A JSON document from chunks of text, without building it. With `target` (the path of an array:
// "" for the top, "watch.patrols", "posts[].officers") each element of that array is parsed on its
// own and handed to onValue. With `counts` (a Map) it counts the objects directly inside every array.
export function jsonScanner({ target = null, onValue, counts = null, stats = {} }) {
  const stack = [];
  const want = target != null;
  let inStr = false;
  let esc = false;
  let isKey = false;
  let keyParts = [];
  let keyStart = 0;
  let expectKey = false;
  let cap = 0; // 1 an object or array, 2 a string, 3 a number, true, false or null
  let capDepth = 0;
  let capStart = 0;
  let capParts = [];
  let stop = false;
  const finish = (s, end) => {
    capParts.push(s.slice(capStart, end));
    const t = capParts.length === 1 ? capParts[0] : capParts.join("");
    capParts = [];
    cap = 0;
    let v;
    try {
      v = JSON.parse(t);
    } catch {
      stats.badLines = (stats.badLines ?? 0) + 1;
      return;
    }
    if (onValue(v) === false) stop = true;
  };
  const atTarget = () => {
    const top = stack[stack.length - 1];
    return top !== undefined && top.arr && top.path === target;
  };
  return {
    write(s) {
      if (cap) capStart = 0;
      if (inStr && isKey) keyStart = 0;
      const n = s.length;
      for (let i = 0; i < n; i++) {
        const c = s.charCodeAt(i);
        if (inStr) {
          if (esc) esc = false;
          else if (c === 92) esc = true;
          else if (c === 34) {
            inStr = false;
            if (isKey) {
              keyParts.push(s.slice(keyStart, i));
              const raw = keyParts.join("");
              let key = raw;
              if (raw.includes("\\")) {
                try {
                  key = JSON.parse(`"${raw}"`);
                } catch {}
              }
              stack[stack.length - 1].key = key;
              isKey = false;
              keyParts = [];
            } else if (cap === 2) {
              finish(s, i + 1);
              if (stop) return false;
            }
          }
          continue;
        }
        if (c === 34) {
          inStr = true;
          const top = stack[stack.length - 1];
          if (expectKey && top !== undefined && !top.arr) {
            isKey = true;
            keyStart = i + 1;
          } else if (!cap && want && atTarget()) {
            cap = 2;
            capStart = i;
          }
        } else if (c === 123 || c === 91) {
          const top = stack[stack.length - 1];
          let p = "";
          if (cap !== 1 && top !== undefined) p = top.arr ? `${top.path}[]` : top.path ? `${top.path}.${top.key}` : String(top.key);
          if (c === 123 && counts && top !== undefined && top.arr) counts.set(top.path, (counts.get(top.path) ?? 0) + 1);
          if (!cap && want && top !== undefined && top.arr && top.path === target) {
            cap = 1;
            capDepth = stack.length;
            capStart = i;
          }
          stack.push({ arr: c === 91, path: p, key: null });
          expectKey = c === 123;
        } else if (c === 125 || c === 93) {
          if (cap === 3) {
            finish(s, i);
            if (stop) return false;
          }
          stack.pop();
          expectKey = false;
          if (cap === 1 && stack.length === capDepth) {
            finish(s, i + 1);
            if (stop) return false;
          }
        } else if (c === 44) {
          if (cap === 3) {
            finish(s, i);
            if (stop) return false;
          }
          const top = stack[stack.length - 1];
          expectKey = top !== undefined && !top.arr;
        } else if (c === 58) expectKey = false;
        else if (c === 32 || c === 10 || c === 13 || c === 9) {
          if (cap === 3) {
            finish(s, i);
            if (stop) return false;
          }
        } else if (!cap && want && atTarget()) {
          cap = 3;
          capStart = i;
        }
      }
      if (cap) capParts.push(s.slice(capStart));
      if (inStr && isKey) keyParts.push(s.slice(keyStart));
      return true;
    },
    end() {
      return { unterminated: stack.length > 0 };
    },
  };
}

// ---- files ----

const EXT = { csv: "csv", tsv: "tsv", tab: "tsv", psv: "csv", jsonl: "jsonl", ndjson: "jsonl", json: "json", geojson: "json", parquet: "parquet", pq: "parquet", xlsx: "xlsx" };
/** {format, gz} from a file name; format is null when the extension says nothing. */
export function formatOf(file) {
  let base = path.basename(file).toLowerCase();
  const gz = base.endsWith(".gz");
  if (gz) base = base.slice(0, -3);
  const ext = base.includes(".") ? base.split(".").pop() : "";
  return { format: EXT[ext] ?? null, gz, ext };
}
const DELIM_NAME = { ",": ",", "\t": "tab", ";": ";", "|": "|" };
const delimOf = (d) => (d == null ? null : d === "tab" || d === "\\t" || d === "tsv" ? "\t" : d === "comma" ? "," : d === "semicolon" ? ";" : d === "pipe" ? "|" : String(d)[0]);

function onPath(program) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const e of exts) {
      const p = path.join(dir, program + e.toLowerCase());
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

const NO_DUCKDB = "duckdb is not installed, and this kit reads Parquet and Excel files only through it. Install it (https://duckdb.org/docs/installation: `brew install duckdb`, `winget install DuckDB.cli`, or `curl https://install.duckdb.org | sh`) and ask again. CSV, TSV, JSON lines, JSON and gzip of these need nothing.";

export function make({ settings = {}, push = () => {}, act = false } = {}) {
  const WORKDIR = path.resolve(String(settings.WORKDIR || process.cwd()));
  const duckdb = onPath("duckdb");
  const rel = (abs) => {
    const r = path.relative(WORKDIR, abs);
    return r && !r.startsWith("..") && !path.isAbsolute(r) ? r.split(path.sep).join("/") : abs;
  };
  const absOf = (file) => {
    let f = String(file);
    if (f === "~" || f.startsWith("~/") || f.startsWith("~\\")) f = path.join(os.homedir(), f.slice(1));
    return path.resolve(WORKDIR, f);
  };

  // Data files under a folder, by a bounded walk: at most 6 levels and 20000 entries, skipping
  // hidden folders, node_modules and the like, and the usual JSON configuration files.
  function listFiles(dir, max = 200) {
    const root = dir ? absOf(dir) : WORKDIR;
    const found = [];
    let seen = 0;
    let cut = false;
    const walk = (d, depth) => {
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const e of entries) {
        if (++seen > 20_000) return void (cut = true);
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
          if (depth < 6) walk(p, depth + 1);
          else cut = true;
        } else if (e.isFile()) {
          const { format } = formatOf(e.name);
          if (!format || SECRET_FILE.test(p)) continue;
          if (format === "json" && CONFIG_JSON.test(e.name)) continue;
          let bytes = 0;
          try {
            bytes = fs.statSync(p).size;
          } catch {}
          found.push({ path: rel(p), format: formatOf(e.name).gz ? `${format}.gz` : format, bytes, size: human(bytes) });
        }
      }
    };
    if (fs.existsSync(root)) walk(root, 0);
    return { root, found, cut, max };
  }

  // The file a caller means: the path as given, or a data file under WORKDIR whose name matches
  // (exact name first, then a substring). Returns {abs} or {error}.
  function locate(file) {
    if (file == null || file === "") throw new Error("a `file` is needed: a path, relative to the working folder, or a file name");
    const abs = absOf(file);
    if (SECRET_FILE.test(abs)) deny(`${file} looks like a file of credentials, and what is read here goes to a cloud model. Ask the user for the one value you need, or use a copy without the secrets`);
    let st = null;
    try {
      st = fs.statSync(abs);
    } catch {}
    if (st?.isFile()) return { abs, bytes: st.size, mtime: st.mtimeMs };
    const { found } = listFiles();
    if (st?.isDirectory()) return { error: `${rel(abs)} is a folder, not a file. Data files in the working folder: ${found.slice(0, 20).map((f) => f.path).join(", ") || "none"}` };
    const want = String(file).toLowerCase();
    const base = (f) => f.path.split("/").pop().toLowerCase();
    const exact = found.filter((f) => base(f) === want || f.path.toLowerCase() === want);
    const stem = exact.length ? exact : found.filter((f) => base(f).replace(/(\.[a-z0-9]+)?(\.gz)?$/, "") === want);
    const sub = stem.length ? stem : found.filter((f) => f.path.toLowerCase().includes(want));
    if (sub.length === 1) {
      const a = absOf(sub[0].path);
      const s = fs.statSync(a);
      return { abs: a, bytes: s.size, mtime: s.mtimeMs, matched: `"${file}" matched ${sub[0].path} by ${exact.length ? "name" : stem.length ? "name without its extension" : "substring"}` };
    }
    if (sub.length > 1) throw new Error(`"${file}" matches ${sub.length} files: ${sub.slice(0, 15).map((f) => f.path).join(", ")}. Give one of these paths.`);
    return { error: `no file ${file} (looked for ${abs}). Data files under ${WORKDIR}: ${found.slice(0, 25).map((f) => f.path).join(", ") || "none"}${found.length > 25 ? ` and ${found.length - 25} more` : ""}` };
  }

  // Decoded text of a file, chunk by chunk; gunzipped when needed. UTF-8, or UTF-16 with a byte order mark.
  async function* chunks(abs, gz, info = {}) {
    const src = fs.createReadStream(abs, { highWaterMark: 1 << 20 });
    const stream = gz ? src.pipe(zlib.createGunzip()) : src;
    if (gz) src.on("error", (e) => stream.destroy(e));
    let dec = null;
    try {
      for await (const buf of stream) {
        let b = buf;
        if (!dec) {
          if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) (dec = new TextDecoder("utf-16le")), (info.encoding = "utf-16le"), (info.bom = true);
          else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) (dec = new TextDecoder("utf-16be")), (info.encoding = "utf-16be"), (info.bom = true);
          else {
            dec = new TextDecoder("utf-8");
            if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) info.bom = true;
          }
        }
        const s = dec.decode(b, { stream: true });
        if (s) yield s;
      }
      const tail = dec?.decode() ?? "";
      if (tail) yield tail;
    } finally {
      src.destroy();
      if (gz) stream.destroy();
    }
  }

  const duckSource = (P) => `${P.format === "parquet" ? "read_parquet" : "read_xlsx"}('${P.abs.replace(/'/g, "''")}')`;

  // Run duckdb on one statement and hand each row of its JSON-lines output to onValue. Unverified on the machine this was written on.
  function duckRows(sql, onValue, { cwd = WORKDIR, timeoutMs = TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
      const started = Date.now();
      const stats = {};
      let err = "";
      let stopped = false;
      const child = spawn(duckdb ?? "duckdb", ["-jsonlines", "-c", sql], { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const timer = setTimeout(() => ((stats.timedOut = true), child.kill()), timeoutMs);
      const parser = linesParser(onValue, stats);
      const dec = new TextDecoder("utf-8");
      child.stdout.on("data", (b) => {
        if (stopped) return;
        if (parser.write(dec.decode(b, { stream: true })) === false) {
          stopped = true;
          child.kill();
        }
      });
      child.stderr.on("data", (b) => (err.length < 4000 ? (err += b) : 0));
      const done = (code, error) => {
        clearTimeout(timer);
        if (!stopped) parser.end();
        push({ kind: "duckdb", detail: sql.replace(/\s+/g, " ").slice(0, 200), ms: Date.now() - started, code });
        resolve({ code, stopped, error: error ?? (code !== 0 && !stopped ? (stats.timedOut ? `duckdb did not finish in ${timeoutMs / 1000} s` : scrub(err.trim()).slice(0, 1500) || `duckdb exited with ${code}`) : null) });
      };
      child.on("error", (e) => done(127, e.code === "ENOENT" ? NO_DUCKDB : String(e.message)));
      child.on("close", (code) => done(stopped ? 0 : (code ?? 1)));
    });
  }

  // Every record of a file, in order: arrays of cells for CSV and TSV (the header row included),
  // parsed values for the JSON formats. cb returns false to stop. Returns {stopped, error?, ...}.
  async function pump(P, cb, { timeoutMs = TIMEOUT_MS, between } = {}) {
    const started = Date.now();
    const out = { stopped: false };
    if (P.format === "parquet" || P.format === "xlsx") {
      const r = await duckRows(`SELECT * FROM ${duckSource(P)}`, cb, { timeoutMs });
      if (r.error) out.error = r.error;
      out.stopped = r.stopped;
      return out;
    }
    if (P.format === "json" && P.oneDoc) {
      try {
        const raw = fs.readFileSync(P.abs);
        if (cb(JSON.parse((P.gz ? zlib.gunzipSync(raw) : raw).toString("utf8").replace(/^\uFEFF/, ""))) === false) out.stopped = true;
      } catch (e) {
        out.error = `not valid JSON: ${e.message.slice(0, 200)}`;
      }
      return out;
    }
    const stats = {};
    const parser = P.format === "jsonl" ? linesParser(cb, stats) : P.format === "json" ? jsonScanner({ target: P.path, onValue: cb, counts: P.counting ?? null, stats }) : csvParser(P.delimiter, cb);
    const info = {};
    let chars = 0;
    try {
      let first = true;
      for await (let s of chunks(P.abs, P.gz, info)) {
        if (first) {
          first = false;
          if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
        }
        chars += s.length;
        if (parser.write(s) === false) {
          out.stopped = true;
          break;
        }
        if (Date.now() - started > timeoutMs) {
          out.stopped = true;
          out.timedOut = true;
          break;
        }
        if (between) await between();
      }
      if (!out.stopped) Object.assign(out, parser.end());
    } catch (e) {
      out.error = e.code === "Z_DATA_ERROR" || e.code === "Z_BUF_ERROR" ? `not a valid gzip file: ${e.message}` : e.code === "ENOENT" ? "the file is gone" : `could not read: ${e.message}`;
    }
    Object.assign(out, stats, info);
    push({ kind: "data.read", detail: rel(P.abs), ms: Date.now() - started, code: out.error ? 1 : 0, size: chars });
    return out;
  }

  async function readHead(abs, gz) {
    const info = {};
    let s = "";
    let whole = true;
    try {
      for await (const c of chunks(abs, gz, info)) {
        s += c;
        if (s.length >= HEAD_CHARS) {
          whole = false;
          break;
        }
      }
    } catch (e) {
      return { error: e.code === "Z_DATA_ERROR" || e.code === "Z_BUF_ERROR" ? `not a valid gzip file: ${e.message}` : `could not read: ${e.message}` };
    }
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return { text: s, whole, ...info };
  }

  function sniffDelimiter(head, whole) {
    let best = { d: ",", score: 0, n: 1 };
    for (const d of [",", "\t", ";", "|"]) {
      const recs = [];
      const p = csvParser(d, (r) => (recs.push(r.length), recs.length < 40));
      if (p.write(head) !== false && whole) p.end();
      if (!whole && recs.length > 1) recs.pop();
      if (!recs.length) continue;
      const by = new Map();
      for (const n of recs) by.set(n, (by.get(n) ?? 0) + 1);
      const [n, c] = [...by].sort((a, b) => b[1] - a[1])[0];
      const score = n > 1 ? (c / recs.length) * 1000 + Math.min(n, 100) : 0;
      if (score > best.score) best = { d, score, n };
    }
    return best.d;
  }

  const prepared = new Map();
  // What has to be known before rows are read: the format, the delimiter and header of a delimited
  // file, the array a JSON document's rows come from, the column names and which of them are secret.
  async function prepare(file, o = {}) {
    const loc = locate(file);
    if (loc.error) return { file: String(file), error: loc.error };
    const key = [loc.abs, loc.mtime, loc.bytes, o.delimiter ?? "", o.header ?? "", o.path ?? "", o.format ?? "", o.flatten ?? ""].join("|");
    if (prepared.has(key)) return prepared.get(key);
    const f = formatOf(loc.abs);
    const P = { abs: loc.abs, file: rel(loc.abs), bytes: loc.bytes, gz: f.gz, format: o.format ?? f.format, notes: [], flatten: o.flatten !== false };
    if (loc.matched) P.matched = loc.matched;
    const failed = (error) => ({ file: P.file, error, ...(P.matched ? { matched: P.matched } : {}) });
    if (/^(xls|xlsm|xlsb|ods)$/.test(f.ext)) return failed(`.${f.ext} files are not read here (duckdb reads .xlsx only). Save the sheet as .xlsx or .csv and ask again.`);
    if (/^(sqlite3?|db)$/.test(f.ext)) return failed("this is a SQLite database, not a data file; ask the sqlite kit");
    if (P.format === "parquet" || P.format === "xlsx") {
      if (!duckdb) return failed(NO_DUCKDB);
    } else {
      const head = await readHead(P.abs, P.gz);
      if (head.error) return failed(head.error);
      if (head.bom) P.notes.push(`starts with a byte order mark (${head.encoding ?? "utf-8"}); it is not part of the first column's name`);
      const t = head.text;
      if (t.slice(0, 4000).includes("\u0000")) return failed("this looks like a binary file, not CSV, TSV or JSON");
      const lead = t.trimStart()[0];
      if (!P.format || P.format === "json") {
        // JSON lines under another name: the first two lines are each a JSON object.
        const ls = t.split("\n", 3).map((l) => l.trim());
        const two = lead === "{" && ls.length > 1 && ls[1].startsWith("{") && (() => { try { return typeof JSON.parse(ls[0]) === "object"; } catch { return false; } })();
        if (two) {
          if (P.format === "json") P.notes.push("the file is named .json but holds one JSON object per line; read as JSON lines");
          P.format = "jsonl";
        } else if (!P.format) P.format = lead === "[" || lead === "{" ? "json" : "csv";
      }
      if (P.format === "csv" || P.format === "tsv") {
        P.delimiter = delimOf(o.delimiter) ?? (P.format === "tsv" ? "\t" : sniffDelimiter(t, head.whole));
        const recs = [];
        const p = csvParser(P.delimiter, (r) => (recs.push(r), recs.length < 60));
        if (p.write(t) !== false && head.whole) p.end();
        if (!head.whole && recs.length > 1) recs.pop();
        const first = recs[0] ?? [];
        const second = recs[1];
        P.header = o.header != null ? !(o.header === false || o.header === "false" || o.header === "none" || o.header === 0) : (() => {
          const named = first.map((c) => c.trim()).filter(Boolean);
          return named.length > 0 && named.every((c) => typeOf(c) === "string");
        })();
        P.headerHow = o.header != null ? "as given" : P.header ? "detected: the first row holds only text" : first.length ? "none detected: the first row holds a number, a date or a boolean, so the columns are named col1, col2, ..." : "the file is empty";
        const width = P.header ? first.length : Math.max(first.length, second?.length ?? 0);
        const names = [];
        const used = new Set();
        const renamed = [];
        for (let i = 0; i < width; i++) {
          let n = P.header ? first[i].trim() : `col${i + 1}`;
          if (!n) n = `col${i + 1}`;
          if (used.has(n)) {
            let k = 2;
            while (used.has(`${n}_${k}`)) k++;
            renamed.push(`${n} (column ${i + 1}) is read as ${n}_${k}`);
            n = `${n}_${k}`;
          }
          used.add(n);
          names.push(n);
        }
        if (renamed.length) P.notes.push(`duplicate header names: ${renamed.slice(0, 8).join("; ")}`);
        P.columns = names;
      } else if (P.format === "json") {
        if (o.path != null) P.path = String(o.path).replace(/^\$\.?/, "");
        else if (lead === "[") P.path = "";
        else {
          // A nested document: count the objects in every array, then read rows from the largest array that is not inside another array.
          const counts = new Map();
          const r = await pump({ ...P, path: null, counting: counts }, () => true);
          if (r.error) return failed(r.error);
          const all = [...counts].sort((a, b) => b[1] - a[1]);
          const top = all.filter(([p]) => !p.includes("[]"));
          if (top.length) {
            P.path = top[0][0];
            P.pathHow = `the largest array of objects in the document (${top[0][1]} objects)`;
            const others = all.filter(([p]) => p !== P.path).slice(0, 8);
            if (others.length) P.otherPaths = others.map(([p, n]) => `${p} (${n})`);
          } else if (P.bytes <= ONE_DOC_MAX) {
            P.oneDoc = true;
            P.path = null;
            P.notes.push(`no array of objects at the top of this document; it is read as one row with its keys as columns${all.length ? `. Arrays inside arrays, readable with path: ${all.slice(0, 6).map(([p, n]) => `${p} (${n})`).join(", ")}` : ""}`);
          } else return failed("this JSON document has no array of objects outside another array; give `path` to the array to read");
        }
      }
    }
    if (!P.columns) {
      // Columns of a JSON source: the keys seen in its first 1000 rows, in order of appearance.
      const cols = new Map();
      let n = 0;
      const r = await pump(P, (v) => {
        const row = v && typeof v === "object" && !Array.isArray(v) ? (P.flatten ? flatten(v, "", {}, 0) : v) : { value: v };
        for (const k in row) if (!cols.has(k)) cols.set(k, true);
        return ++n < 1000;
      });
      if (r.error) return failed(r.error);
      P.columns = [...cols.keys()];
      P.open = true; // later rows may bring more keys
      if (P.format === "json" && !P.oneDoc && n === 0) {
        const counts = new Map();
        await pump({ ...P, path: null, counting: counts }, () => true);
        const have = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([p, c]) => `${p === "" ? '"" (the top)' : p} (${c})`);
        if (o.path != null) return failed(`no rows at path ${P.path || '""'} in ${P.file}. Arrays of objects in it: ${have.join(", ") || "none"}`);
        P.notes.push("the top-level array holds no rows");
      }
    }
    P.secret = new Set(P.columns.filter(isSecretName));
    if (prepared.size > 50) prepared.clear();
    prepared.set(key, P);
    return P;
  }

  const describe = (P) => ({
    file: P.file,
    ...(P.matched ? { matched: P.matched } : {}),
    format: P.gz ? `${P.format}.gz` : P.format,
    ...(P.delimiter ? { delimiter: DELIM_NAME[P.delimiter] ?? P.delimiter, header: P.header } : {}),
    ...(P.format === "json" && !P.oneDoc ? { path: P.path === "" ? "(top-level array)" : P.path, ...(P.pathHow ? { pathChosen: P.pathHow } : {}), ...(P.otherPaths ? { otherPaths: P.otherPaths } : {}) } : {}),
  });

  // Rows of a prepared file. For CSV and TSV a row is an array of cells in column order; for the
  // JSON formats it is an object (nested objects flattened to dotted keys). `get(name)` gives a
  // reader that works on either. Secret columns hold <redacted> unless o.raw (never set for the caller).
  async function scan(P, o, onRow) {
    const delimited = !!P.delimiter;
    const width = P.columns.length;
    const index = new Map(P.columns.map((c, i) => [c, i]));
    const secretIdx = o.raw ? [] : P.columns.map((c, i) => (P.secret.has(c) ? i : -1)).filter((i) => i >= 0);
    const ragged = { short: 0, long: 0, first: 0 };
    const extra = [];
    let n = 0;
    let skipHeader = delimited && P.header;
    const r = await pump(
      P,
      delimited
        ? (cells) => {
            if (skipHeader) return void (skipHeader = false);
            n++;
            if (cells.length !== width) {
              if (cells.length < width) ragged.short++;
              else ragged.long++;
              ragged.first ||= n;
            }
            for (const i of secretIdx) if (cells[i]) cells[i] = REDACTED;
            return onRow(cells, n);
          }
        : (v) => {
            n++;
            const row = v && typeof v === "object" && !Array.isArray(v) ? (P.flatten ? flatten(v, "", {}, 0) : v) : { value: v };
            if (P.open) for (const k in row) if (!index.has(k)) (index.set(k, index.size), extra.push(k));
            if (!o.raw) for (const k in row) if (row[k] != null && row[k] !== "" && isSecretName(k)) row[k] = REDACTED;
            return onRow(row, n, v);
          },
      { timeoutMs: o.timeoutMs, between: o.between },
    );
    const notes = [];
    if (ragged.short || ragged.long) notes.push(`ragged rows: ${ragged.short} with fewer cells than the ${width} columns (the missing ones read as empty), ${ragged.long} with more (the extra cells are ignored); the first is row ${ragged.first}`);
    if (r.unterminated) notes.push(delimited ? "the file ends inside a quoted field: a closing quote is missing" : "the JSON document ends before it is closed: the file is cut short");
    if (r.badLines) notes.push(P.format === "json" ? `elements that are not valid JSON and were skipped: ${r.badLines}` : `lines that are not valid JSON and were skipped: ${r.badLines} (the first is line ${r.firstBadLine})`);
    if (r.timedOut) notes.push(`stopped after ${(o.timeoutMs ?? TIMEOUT_MS) / 1000} s at row ${n}; the numbers cover the rows read so far`);
    if (extra.length) notes.push(`columns that first appear after row 1000: ${extra.slice(0, 20).join(", ")}`);
    return { rows: n, stopped: r.stopped, timedOut: !!r.timedOut, error: r.error, notes, extra };
  }

  const getter = (P, name) => {
    if (P.delimiter) {
      const i = P.columns.indexOf(name);
      return (row) => row[i] ?? "";
    }
    return (row) => row[name];
  };
  const toObject = (P, cols, row) => {
    const o = {};
    if (P.delimiter && cols === P.columns) for (let i = 0; i < cols.length; i++) o[cols[i]] = row[i] ?? "";
    else if (P.delimiter) for (const c of cols) o[c] = row[P.columns.indexOf(c)] ?? "";
    else for (const c of cols) o[c] = row[c] ?? null;
    return o;
  };

  // The column a caller means: exact name, then the same name in another case, then the only column that contains it.
  function column(P, given, how = []) {
    const g = String(given);
    if (P.columns.includes(g)) return g;
    const lower = P.columns.filter((c) => c.toLowerCase() === g.toLowerCase());
    if (lower.length === 1) return how.push(`column "${g}" is ${lower[0]} (same name, other case)`), lower[0];
    const sub = P.columns.filter((c) => c.toLowerCase().includes(g.toLowerCase()));
    if (sub.length === 1) return how.push(`column "${g}" matched ${sub[0]} by substring`), sub[0];
    if (sub.length > 1) throw new Error(`column "${g}" matches several in ${P.file}: ${sub.slice(0, 20).join(", ")}. Give one of them.`);
    if (P.open) return how.push(`column "${g}" is not in the first 1000 rows of ${P.file}; it is used as written`), g;
    throw new Error(`no column ${g} in ${P.file}; have: ${P.columns.slice(0, 60).join(", ")}${P.columns.length > 60 ? ` and ${P.columns.length - 60} more` : ""}`);
  }
  const list = (v) => (v == null || v === "" ? [] : Array.isArray(v) ? v.map(String) : String(v).split(",").map((s) => s.trim()).filter(Boolean));
  const parseJson = (v, what) => {
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      throw new Error(`\`${what}\` must be an object such as {"rank": "Sergeant"} or {"pay": {"gte": 30}}; got the text ${v.slice(0, 80)}`);
    }
  };

  const OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "matches", "empty"];
  const same = (cell, want) => {
    if (want == null) return isEmpty(cell);
    if (typeof want === "number") return num(cell) === want;
    if (typeof want === "boolean") return typeof cell === "boolean" ? cell === want : typeof cell === "string" && cell.toLowerCase() === String(want);
    return text(cell) === String(want);
  };
  const order = (a, b) => {
    const x = num(a);
    const y = num(b);
    if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y;
    const s = text(a);
    const t = text(b);
    return s < t ? -1 : s > t ? 1 : 0;
  };
  // {col: value} and {col: {gt, gte, lt, lte, ne, in, contains, matches, empty}}, all of them true; {or: [where, ...]} for any of.
  // `misses` counts, per column, the cells a number comparison could not use because they are not written as numbers.
  function compileWhere(P, where, how, misses = {}) {
    const w = parseJson(where, "where");
    if (w == null) return null;
    if (typeof w !== "object" || Array.isArray(w)) throw new Error('`where` must be an object such as {"rank": "Sergeant"} or {"pay": {"gte": 30}}');
    const tests = [];
    for (const [k, cond] of Object.entries(w)) {
      if (k === "or" && Array.isArray(cond) && !P.columns.includes("or")) {
        const any = cond.map((c) => compileWhere(P, c, how, misses)).filter(Boolean);
        tests.push((row) => any.some((t) => t(row)));
        continue;
      }
      const name = column(P, k, how);
      const get = getter(P, name);
      const ops = cond && typeof cond === "object" && !Array.isArray(cond) ? cond : Array.isArray(cond) ? { in: cond } : { eq: cond };
      for (const [op, v] of Object.entries(ops)) {
        if (!OPS.includes(op)) throw new Error(`unknown condition "${op}" on ${name}; have: ${OPS.join(", ")}`);
        if (isSecretName(name) && op !== "empty") throw new Error(`not allowed: ${name} is a redacted column, so its values cannot be compared (a filter would reveal them). Only {"${name}": {"empty": true}} works on it.`);
        if (op === "eq") tests.push((row) => same(get(row), v));
        else if (op === "ne") tests.push((row) => !same(get(row), v));
        else if (op === "in") {
          const vs = [].concat(v);
          tests.push((row) => vs.some((x) => same(get(row), x)));
        } else if (op === "contains") {
          const needle = String(v).toLowerCase();
          tests.push((row) => text(get(row)).toLowerCase().includes(needle));
        } else if (op === "matches") {
          let re;
          try {
            re = new RegExp(String(v), "i");
          } catch (e) {
            throw new Error(`"matches" on ${name} is not a valid regular expression: ${e.message}`);
          }
          tests.push((row) => re.test(text(get(row))));
        } else if (op === "empty") tests.push((row) => isEmpty(get(row)) === (v !== false && v !== "false"));
        else {
          const cmp = { gt: (c) => c > 0, gte: (c) => c >= 0, lt: (c) => c < 0, lte: (c) => c <= 0 }[op];
          const wantNumber = !Number.isNaN(num(v));
          tests.push((row) => {
            const cell = get(row);
            if (isEmpty(cell)) return false;
            if (wantNumber && Number.isNaN(num(cell))) return (misses[name] = (misses[name] ?? 0) + 1), false;
            return cmp(order(cell, v));
          });
        }
      }
    }
    if (!tests.length) return null;
    return tests.length === 1 ? tests[0] : (row) => tests.every((t) => t(row));
  }

  const missNotes = (misses, how) => {
    for (const [c, n] of Object.entries(misses)) how.push(`cells in ${c} not written as numbers, which a number comparison cannot match: ${n} (see them with values)`);
  };
  const withNotes = (out, P, s, how) => {
    const notes = [...(how ?? []), ...P.notes, ...(s?.notes ?? [])];
    const red = P.columns.filter(isSecretName);
    if (red.length) notes.push(`redacted, because the name looks like a credential: ${red.join(", ")}`);
    if (notes.length) out.notes = notes;
    return out;
  };

  // ---- the global ----

  const data = {
    /** The folder relative paths are resolved against. */
    workdir: WORKDIR,
    /** True when the duckdb program is on PATH: Parquet and Excel files can be read and data.sql works. */
    duckdb: !!duckdb,

    /** Data files under a folder (default the working folder): {dir, files:[{path, format, bytes, size}], leftOut}. */
    files(dir, o = {}) {
      const max = Math.min(o.max ?? 200, 1000);
      const { root, found, cut } = listFiles(dir, max);
      if (!fs.existsSync(root)) return { dir: root, error: `no folder ${root}` };
      const out = { dir: root, count: found.length, files: found.slice(0, max) };
      if (found.length > max) out.leftOut = found.length - max;
      if (cut) out.note = "the walk stopped at 6 levels or 20000 entries; give a deeper folder to see more";
      return out;
    },

    /** The first rows of a file as objects: {file, format, columns, rows, complete}. For a look at the data; use rows() to filter. */
    async open(file, o = {}) {
      const P = await prepare(file, o);
      if (P.error) return P;
      const limit = Math.max(0, Math.min(Number(o.limit ?? 20), 500));
      const rows = [];
      let more = false;
      const s = await scan(P, o, (row) => {
        if (rows.length >= limit) return (more = true), false;
        const obj = toObject(P, P.delimiter ? P.columns : Object.keys(row), row);
        for (const k in obj) obj[k] = show(obj[k], 2000);
        rows.push(obj);
      });
      if (s.error) return { ...describe(P), error: s.error };
      return withNotes({ ...describe(P), columns: P.columns, rows, complete: !more }, P, s);
    },

    /** Call fn(row, n) for every row, streaming; return false from fn to stop. Returns {file, format, columns, rows, stopped}. */
    async each(file, fn, o = {}) {
      if (typeof fn !== "function") throw new Error("each(file, fn, opts) needs a function; it is called with (row, n) and may return false to stop");
      const P = await prepare(file, o);
      if (P.error) return P;
      const s = await scan(P, o, (row, n) => fn(P.delimiter ? toObject(P, P.columns, row) : row, n));
      if (s.error) return { ...describe(P), error: s.error };
      return withNotes({ ...describe(P), columns: [...P.columns, ...s.extra], rows: s.rows, stopped: s.stopped }, P, s);
    },

    /**
     * What a file holds: exact row count, and per column its type, empty count, distinct count, min, max and top values.
     * A file over 64 MB (16 MB gzipped) has its statistics taken from the first 100000 rows unless o.full.
     */
    async profile(file, o = {}) {
      const P = await prepare(file, o);
      if (P.error) return P;
      const top = Math.max(0, Math.min(Number(o.top ?? 5), 25));
      const big = P.bytes > (P.gz ? LARGE_GZ : LARGE);
      const sample = o.full ? Infinity : Number(o.sample ?? (big ? SAMPLE : Infinity));
      const stats = new Map();
      const stat = (name) => {
        let c = stats.get(name);
        if (!c) stats.set(name, (c = { n: 0, empty: 0, types: {}, min: Infinity, max: -Infinity, sum: 0, nums: 0, lo: null, hi: null, maxLen: 0, distinct: new Map(), over: false, padded: 0 }));
        return c;
      };
      const add = (c, v) => {
        c.n++;
        const t = typeOf(v);
        if (t === "empty") return void c.empty++;
        c.types[t] = (c.types[t] ?? 0) + 1;
        if (t === "integer" || t === "number") {
          const x = Number(v);
          if (x < c.min) c.min = x;
          if (x > c.max) c.max = x;
          c.sum += x;
          c.nums++;
        }
        let key = typeof v === "string" ? v : text(v);
        if (t === "string" || t === "date" || t === "timestamp") {
          if (c.lo === null || key < c.lo) c.lo = key;
          if (c.hi === null || key > c.hi) c.hi = key;
          if (key.length > c.maxLen) c.maxLen = key.length;
          if (t === "string" && (key.charCodeAt(0) <= 32 || key.charCodeAt(key.length - 1) <= 32)) c.padded++;
        }
        if (key.length > 120) key = `${key.slice(0, 120)}…`;
        const seen = c.distinct.get(key);
        if (seen !== undefined) c.distinct.set(key, seen + 1);
        else if (c.distinct.size < DISTINCT_CAP) c.distinct.set(key, 1);
        else c.over = true;
      };
      const cols = P.delimiter ? P.columns.map(stat) : null;
      let sampled = 0;
      const s = await scan(P, { ...o, raw: true }, (row, n) => {
        if (n > sample) return;
        sampled = n;
        if (cols) for (let i = 0; i < cols.length; i++) add(cols[i], row[i] ?? "");
        else {
          for (const k in row) add(stat(k), row[k]);
        }
      });
      if (s.error) return { ...describe(P), error: s.error };
      const names = [...stats.keys()];
      const only = o.columns ? list(o.columns).map((c) => column({ ...P, columns: names }, c)) : null;
      const notes = [];
      const columns = [];
      for (const name of only ?? names) {
        const c = stats.get(name);
        const empty = c.empty + (sampled - c.n); // a key missing from a JSON row counts as empty
        const kinds = Object.keys(c.types);
        let type = kinds.length === 0 ? "empty" : kinds.length === 1 ? kinds[0] : kinds.every((k) => k === "integer" || k === "number") ? "number" : kinds.every((k) => k === "date" || k === "timestamp") ? "timestamp" : "mixed";
        const col = { name, type, empty, distinct: c.over ? `over ${DISTINCT_CAP}` : c.distinct.size };
        if (type === "mixed") {
          col.mixed = c.types;
          notes.push(`mixed types in ${name}: ${Object.entries(c.types).map(([k, v]) => `${v} ${k}`).join(", ")}`);
        }
        if (isSecretName(name)) {
          col.redacted = true;
          columns.push(col);
          continue;
        }
        if (type === "integer" || type === "number") Object.assign(col, { min: c.min, max: c.max, mean: Number((c.sum / c.nums).toPrecision(6)) });
        else if (type === "date" || type === "timestamp") Object.assign(col, { min: c.lo, max: c.hi });
        else if (c.lo !== null) col.maxLength = c.maxLen;
        const filled = sampled - empty;
        const numeric = type === "integer" || type === "number";
        if (!c.over && c.distinct.size === filled && filled > 1) {
          col.unique = true;
          if (top) col.examples = [...c.distinct.keys()].slice(0, 3).map((v) => show(v, 40)).join(" | ");
        } else if (top && !(numeric && (c.over || c.distinct.size > 12))) {
          // The most frequent values as "value (count)", in one line to keep the profile small.
          const best = [...c.distinct].sort((a, b) => b[1] - a[1]).slice(0, top);
          if (c.over && best[0][1] === 1) col.examples = best.slice(0, 3).map(([v]) => show(v, 40)).join(" | ");
          else if (best.length) col.top = best.map(([value, count]) => `${show(value, 40)} (${count})`).join(" | ");
          if (c.over && col.top) col.topApprox = `counted among the first ${DISTINCT_CAP} distinct values only`;
        }
        if (c.padded) notes.push(`values in ${name} that start or end with a space: ${c.padded}`);
        columns.push(col);
      }
      const out = { ...describe(P), bytes: P.bytes, size: human(P.bytes), rows: s.rows, columnCount: names.length, columns: columns.slice(0, 80) };
      if (s.timedOut) out.rowsNote = "the row count is not complete: the read was stopped";
      if (columns.length > 80) out.columnsLeftOut = columns.length - 80;
      if (sampled < s.rows) out.sampled = `rows are counted exactly; types, empty and distinct counts, min, max and top values come from the first ${sampled} rows. Pass full: true to read all ${s.rows}.`;
      if (P.delimiter) notes.unshift(`header: ${P.headerHow}`);
      return withNotes(out, P, { notes: [...s.notes.filter((x) => !x.startsWith("columns that first")), ...notes] });
    },

    /**
     * Rows that match `where`: {count, rows, ...}. o.select picks columns, o.sort orders ("pay", "-pay", or a list),
     * o.limit caps the list (default 20, at most 200). `count` is all matches; with count: false the read stops at the limit.
     */
    async rows(file, o = {}) {
      const P = await prepare(file, o);
      if (P.error) return P;
      const how = [];
      const misses = {};
      const test = compileWhere(P, o.where, how, misses);
      const limit = Math.max(0, Math.min(Number(o.limit ?? 20), 200));
      let select = list(o.select).map((c) => column(P, c, how));
      const sorts = list(typeof o.sort === "object" && o.sort && !Array.isArray(o.sort) ? Object.entries(o.sort).map(([k, d]) => (/^desc|^-1$/i.test(String(d)) ? `-${k}` : k)) : o.sort).map((s) => {
        const desc = s.startsWith("-");
        const name = column(P, s.replace(/^[-+]/, ""), how);
        return { get: getter(P, name), desc };
      });
      const compare = (a, b) => {
        for (const s of sorts) {
          const x = s.get(a.row);
          const y = s.get(b.row);
          const ex = isEmpty(x);
          const ey = isEmpty(y);
          if (ex || ey) {
            if (ex !== ey) return ex ? 1 : -1; // empty cells last, whatever the direction
            continue;
          }
          const c = order(x, y);
          if (c) return s.desc ? -c : c;
        }
        return a.n - b.n;
      };
      const counting = o.count !== false && o.count !== "false";
      let kept = [];
      let count = 0;
      const s = await scan(P, o, (row, n) => {
        if (test && !test(row)) return;
        count++;
        if (sorts.length) {
          kept.push({ row, n });
          if (kept.length > limit * 4 + 64) kept = kept.sort(compare).slice(0, limit);
        } else if (kept.length < limit) kept.push({ row, n });
        else if (!counting) return count--, false;
      });
      if (s.error) return { ...describe(P), error: s.error };
      if (sorts.length) kept = kept.sort(compare).slice(0, limit);
      if (!select.length) select = P.delimiter ? P.columns : [...new Set(kept.flatMap((k) => Object.keys(k.row)))];
      const shown = select.slice(0, 40);
      const out = { ...describe(P) };
      const exact = !s.stopped;
      if (exact) out.count = count;
      else out.countNote = s.timedOut ? `at least ${count} matches; the read was stopped` : `the read stopped after ${limit} matches at row ${kept.at(-1)?.n ?? 0}; pass count: true for the number of all matches`;
      if (exact) out.scanned = s.rows;
      out.rows = kept.map((k) => {
        const obj = { _row: k.n };
        for (const c of shown) obj[c] = show(P.delimiter ? k.row[P.columns.indexOf(c)] ?? "" : k.row[c] ?? null);
        return obj;
      });
      if (exact && count > kept.length) out.leftOut = count - kept.length;
      if (select.length > shown.length) out.columnsLeftOut = `${select.length - shown.length} of ${select.length} columns are not shown; name the ones you need in select`;
      missNotes(misses, how);
      if (exact && count === 0 && test) how.push("nothing matched. Text is compared exactly, capitals included: check the spelling with values(file, column), or use contains");
      return withNotes(out, P, s, how);
    },

    /**
     * Counts by group: o.by is one or more columns; o.sum, o.avg, o.min, o.max name numeric columns to aggregate.
     * o.bucket {col: "year"|"month"|"day"|"hour"} groups an ISO date column by its start. Sorted by count, or by o.sort ("sum:pay", "-key"); the top o.top (default 20).
     */
    async group(file, o = {}) {
      const P = await prepare(file, o);
      if (P.error) return P;
      const how = [];
      const by = list(o.by).map((c) => column(P, c, how));
      if (!by.length) throw new Error(`group needs \`by\`: one or more of ${P.columns.slice(0, 40).join(", ")}`);
      const misses = {};
      const test = compileWhere(P, o.where, how, misses);
      const bucket = parseJson(o.bucket, "bucket") ?? {};
      const cut = { year: 4, month: 7, day: 10, hour: 13, minute: 16 };
      const gets = by.map((c) => {
        const g = getter(P, c);
        const b = Object.entries(bucket).find(([k]) => column(P, k) === c)?.[1];
        if (b && !cut[b]) throw new Error(`unknown bucket "${b}"; have: ${Object.keys(cut).join(", ")}`);
        return b ? (row) => text(g(row)).slice(0, cut[b]) : g;
      });
      const aggs = [];
      for (const fn of ["sum", "avg", "min", "max"]) for (const c of list(o[fn])) aggs.push({ fn, name: column(P, c, how) });
      const aggCols = [...new Set(aggs.map((a) => a.name))];
      for (const c of aggCols) if (isSecretName(c)) throw new Error(`not allowed: ${c} is a redacted column and cannot be aggregated`);
      const aggGets = aggCols.map((c) => getter(P, c));
      const groups = new Map();
      let total = 0;
      let lumped = 0;
      const nonNumeric = Object.fromEntries(aggCols.map((c) => [c, 0]));
      const s = await scan(P, o, (row) => {
        if (test && !test(row)) return;
        total++;
        const key = gets.length === 1 ? text(gets[0](row)) : gets.map((g) => text(g(row))).join("\u0001");
        let g = groups.get(key);
        if (!g) {
          if (groups.size >= GROUP_CAP) return void lumped++;
          groups.set(key, (g = { count: 0, a: aggCols.map(() => ({ sum: 0, n: 0, min: Infinity, max: -Infinity })) }));
        }
        g.count++;
        for (let i = 0; i < aggGets.length; i++) {
          const v = aggGets[i](row);
          if (isEmpty(v)) continue;
          const x = num(v);
          if (Number.isNaN(x)) {
            nonNumeric[aggCols[i]]++;
            continue;
          }
          const a = g.a[i];
          a.sum += x;
          a.n++;
          if (x < a.min) a.min = x;
          if (x > a.max) a.max = x;
        }
      });
      if (s.error) return { ...describe(P), error: s.error };
      const value = (g, a) => {
        const st = g.a[aggCols.indexOf(a.name)];
        return st.n === 0 ? null : a.fn === "sum" ? tidy(st.sum) : a.fn === "avg" ? Number((st.sum / st.n).toFixed(4)) : st[a.fn];
      };
      let rows = [...groups].map(([key, g]) => {
        const r = {};
        const parts = key.split("\u0001");
        by.forEach((c, i) => (r[c] = show(parts[i] ?? "", 80)));
        r.count = g.count;
        for (const a of aggs) r[`${a.fn}_${a.name}`] = value(g, a);
        return r;
      });
      const sortBy = String(o.sort ?? "-count");
      const desc = sortBy.startsWith("-") || (!/^[-+]/.test(sortBy) && sortBy !== "key" && !by.includes(sortBy));
      let field = sortBy.replace(/^[-+]/, "").replace(":", "_");
      if (field === "key") field = by[0];
      if (rows.length && !(field in rows[0])) throw new Error(`cannot sort groups by "${o.sort}"; have: key, ${Object.keys(rows[0]).join(", ")}`);
      rows.sort((a, b) => {
        const c = a[field] == null ? (b[field] == null ? 0 : -1) : b[field] == null ? 1 : order(a[field], b[field]);
        return (desc ? -c : c) || (a[by[0]] < b[by[0]] ? -1 : 1);
      });
      const top = Math.max(1, Math.min(Number(o.top ?? 20), 200));
      const out = { ...describe(P), by, total, groups: groups.size, rows: rows.slice(0, top) };
      if (rows.length > top) out.leftOut = `${rows.length - top} groups holding ${rows.slice(top).reduce((n, r) => n + r.count, 0)} rows`;
      missNotes(misses, how);
      if (lumped) how.push(`more than ${GROUP_CAP} groups: ${lumped} rows in groups past that are in the total but not in any group`);
      for (const [c, n] of Object.entries(nonNumeric)) if (n) how.push(`values in ${c} not written as numbers and left out of its sums: ${n} (thousands separators, decimal commas and currency signs are text)`);
      if (s.timedOut) out.incomplete = true;
      return withNotes(out, P, s, how);
    },

    /** The distinct values of one column with their counts, most frequent first: {column, distinct, empty, values:[{value, count}], leftOut}. */
    async values(file, col, o = {}) {
      const P = await prepare(file, o);
      if (P.error) return P;
      if (col == null || col === "") throw new Error(`values needs a column; ${P.file} has: ${P.columns.slice(0, 60).join(", ")}`);
      const how = [];
      const name = column(P, col, how);
      const get = getter(P, name);
      const misses = {};
      const test = compileWhere(P, o.where, how, misses);
      const seen = new Map();
      let empty = 0;
      let total = 0;
      let over = false;
      const s = await scan(P, o, (row) => {
        if (test && !test(row)) return;
        total++;
        const v = get(row);
        if (isEmpty(v)) return void empty++;
        const key = text(v);
        const n = seen.get(key);
        if (n !== undefined) seen.set(key, n + 1);
        else if (seen.size < GROUP_CAP) seen.set(key, 1);
        else over = true;
      });
      if (s.error) return { ...describe(P), error: s.error };
      const top = Math.max(1, Math.min(Number(o.top ?? 50), 500));
      const sorted = [...seen].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      const out = { ...describe(P), column: name, rows: total, distinct: over ? `over ${GROUP_CAP}` : seen.size, empty, values: sorted.slice(0, top).map(([value, count]) => ({ value: show(value, 120), count })) };
      if (sorted.length > top) out.leftOut = sorted.length - top;
      if (!over && seen.size === total - empty && total - empty > 1) out.unique = true;
      missNotes(misses, how);
      if (s.timedOut) out.incomplete = true;
      return withNotes(out, P, s, how);
    },

    /**
     * How two files differ. With o.key (one column or several) rows are paired by it: added, removed and changed rows, with the fields that changed.
     * Without a key whole rows are compared. o.ignore names columns to leave out of the comparison (a date that changes on every row). Values are compared as text, so a CSV can be compared with a JSON file. Lists hold o.limit rows (default 20).
     */
    async diff(a, b, o = {}) {
      const A = await prepare(a, o.a ?? {});
      if (A.error) return A;
      const B = await prepare(b, o.b ?? {});
      if (B.error) return B;
      const how = [];
      const limit = Math.max(0, Math.min(Number(o.limit ?? 20), 100));
      const key = list(o.key).map((c) => column(A, c, how));
      for (const k of key) if (!B.columns.includes(k) && !B.open) throw new Error(`key column ${k} is not in ${B.file}; it has: ${B.columns.slice(0, 40).join(", ")}`);
      const ignore = list(o.ignore).map((c) => column(A, c, how));
      const common = A.columns.filter((c) => B.columns.includes(c) && !ignore.includes(c));
      const out = { a: describe(A), b: describe(B), key: key.length ? key : null, ...(ignore.length ? { ignored: ignore } : {}) };
      const onlyA = A.columns.filter((c) => !B.columns.includes(c));
      const onlyB = B.columns.filter((c) => !A.columns.includes(c));
      if (onlyA.length) out.columnsRemoved = onlyA.slice(0, 40);
      if (onlyB.length) out.columnsAdded = onlyB.slice(0, 40);
      const cells = (P, cols) => {
        const gs = cols.map((c) => getter(P, c));
        return (row) => gs.map((g) => text(g(row)));
      };
      const face = (cols, vals) => Object.fromEntries(cols.map((c, i) => [c, isSecretName(c) && vals[i] !== "" ? REDACTED : show(vals[i], 80)]));
      if (key.length) {
        const rest = common.filter((c) => !key.includes(c));
        const kA = cells(A, key);
        const vA = cells(A, rest);
        const held = new Map();
        let dupA = 0;
        const sa = await scan(A, { raw: true }, (row) => {
          const k = kA(row).join("\u0001");
          if (held.has(k)) return void dupA++;
          if (held.size >= DIFF_CAP) return false;
          held.set(k, vA(row));
        });
        if (sa.error) return { ...out, error: `${A.file}: ${sa.error}` };
        if (sa.stopped && !sa.timedOut) return { ...out, error: `${A.file} has more than ${DIFF_CAP} rows, too many to hold for a diff. Compare a part: write a filtered copy of each (data.write with act) or diff by group counts with group().` };
        const kB = cells(B, key);
        const vB = cells(B, rest);
        const added = [];
        const changed = [];
        const fields = {};
        let nAdded = 0;
        let nChanged = 0;
        let same = 0;
        let dupB = 0;
        const seenB = new Set();
        const sb = await scan(B, { raw: true }, (row) => {
          const kv = kB(row);
          const k = kv.join("\u0001");
          if (seenB.has(k)) return void dupB++;
          if (seenB.size < DIFF_CAP) seenB.add(k);
          const old = held.get(k);
          if (old === undefined) {
            nAdded++;
            if (added.length < limit) added.push(face([...key, ...rest], [...kv, ...vB(row)]));
            return;
          }
          held.delete(k);
          const now = vB(row);
          const diffs = {};
          let any = false;
          for (let i = 0; i < rest.length; i++) {
            if (old[i] === now[i]) continue;
            any = true;
            fields[rest[i]] = (fields[rest[i]] ?? 0) + 1;
            diffs[rest[i]] = isSecretName(rest[i]) ? { from: REDACTED, to: `${REDACTED} (changed)` } : { from: show(old[i], 80), to: show(now[i], 80) };
          }
          if (!any) return void same++;
          nChanged++;
          if (changed.length < limit) changed.push({ ...face(key, kv), changes: diffs });
        });
        if (sb.error) return { ...out, error: `${B.file}: ${sb.error}` };
        const removed = [...held].slice(0, limit).map(([k, v]) => face([...key, ...rest], [...k.split("\u0001"), ...v]));
        Object.assign(out, { rowsA: sa.rows, rowsB: sb.rows, added: nAdded, removed: held.size, changed: nChanged, unchanged: same, changedFields: fields, addedRows: added, removedRows: removed, changedRows: changed });
        if (nAdded > added.length || held.size > removed.length || nChanged > changed.length) out.leftOut = { added: nAdded - added.length, removed: held.size - removed.length, changed: nChanged - changed.length };
        if (dupA || dupB) how.push(`the key is not unique: ${dupA} repeated in ${A.file}, ${dupB} in ${B.file}; only the first row of each key was compared`);
        return withNotes(out, { ...A, notes: [...A.notes.map((n) => `${A.file}: ${n}`), ...B.notes.map((n) => `${B.file}: ${n}`)], columns: [...new Set([...A.columns, ...B.columns])] }, { notes: [...sa.notes, ...sb.notes] }, how);
      }
      // No key: rows are compared whole, over the columns both files have.
      const cA = cells(A, common);
      const cB = cells(B, common);
      const bag = new Map();
      let tooMany = false;
      const sa = await scan(A, { raw: true }, (row) => {
        const k = cA(row).join("\u0001");
        if (!bag.has(k) && bag.size >= DIFF_CAP) return (tooMany = true), false;
        bag.set(k, (bag.get(k) ?? 0) + 1);
      });
      if (sa.error) return { ...out, error: `${A.file}: ${sa.error}` };
      if (tooMany) return { ...out, error: `${A.file} has more than ${DIFF_CAP} distinct rows, too many to hold for a diff. Compare a part, or give a key.` };
      const added = [];
      let nAdded = 0;
      let same = 0;
      const sb = await scan(B, { raw: true }, (row) => {
        const vals = cB(row);
        const k = vals.join("\u0001");
        const n = bag.get(k);
        if (n) {
          same++;
          if (n === 1) bag.delete(k);
          else bag.set(k, n - 1);
          return;
        }
        nAdded++;
        if (added.length < limit) added.push(face(common, vals));
      });
      if (sb.error) return { ...out, error: `${B.file}: ${sb.error}` };
      let nRemoved = 0;
      const removed = [];
      for (const [k, n] of bag) {
        nRemoved += n;
        if (removed.length < limit) removed.push(face(common, k.split("\u0001")));
      }
      Object.assign(out, { rowsA: sa.rows, rowsB: sb.rows, added: nAdded, removed: nRemoved, unchanged: same, addedRows: added, removedRows: removed });
      if (nAdded > added.length || nRemoved > removed.length) out.leftOut = { added: nAdded - added.length, removed: nRemoved - removed.length };
      how.push("no key was given, so whole rows were compared: a row with one changed field shows as one removed and one added. Give a key to see the changed fields.");
      return withNotes(out, { ...A, notes: [], columns: common }, { notes: [...sa.notes, ...sb.notes] }, how);
    },

    /**
     * Which data files under a folder have a column (o.column, matched in any case, by substring) or a value (o.value, a substring of any cell, any case).
     * A value search reads at most 200000 rows of each file and stops after 40 s.
     */
    async find(o = {}) {
      const { root, found, cut } = listFiles(o.dir, 400);
      if (!fs.existsSync(root)) return { dir: root, error: `no folder ${root}` };
      const colWant = o.column != null && o.column !== "" ? String(o.column).toLowerCase() : null;
      const valWant = o.value != null && o.value !== "" ? String(o.value).toLowerCase() : null;
      if (colWant == null && valWant == null) throw new Error("find needs `column` or `value` (or use files() for the list of data files)");
      const started = Date.now();
      const hits = [];
      const unread = [];
      let searched = 0;
      let skipped = 0;
      for (const f of found.slice(0, 400)) {
        if (Date.now() - started > 40_000) {
          skipped++;
          continue;
        }
        let P;
        try {
          P = await prepare(absOf(f.path));
        } catch (e) {
          unread.push(`${f.path}: ${e.message.slice(0, 100)}`);
          continue;
        }
        if (P.error) {
          unread.push(`${f.path}: ${P.error.slice(0, 100)}`);
          continue;
        }
        searched++;
        const hit = { file: P.file, format: f.format, size: f.size };
        if (colWant != null) {
          const cols = P.columns.filter((c) => c.toLowerCase().includes(colWant));
          if (!cols.length) continue;
          hit.columns = cols.slice(0, 20);
        }
        if (valWant != null) {
          const within = hit.columns ?? null;
          const per = {};
          let matches = 0;
          let firstRow = null;
          let example = null;
          const s = await scan(P, { timeoutMs: 10_000 }, (row, n) => {
            if (n > 200_000) return false;
            const keys = within ?? (P.delimiter ? P.columns : Object.keys(row));
            let any = false;
            for (let i = 0; i < keys.length; i++) {
              const v = P.delimiter ? row[within ? P.columns.indexOf(keys[i]) : i] : row[keys[i]];
              if (v == null || v === "" || v === REDACTED) continue;
              if (text(v).toLowerCase().includes(valWant)) {
                per[keys[i]] = (per[keys[i]] ?? 0) + 1;
                any = true;
                if (example === null) example = show(v, 100);
              }
            }
            if (any) {
              matches++;
              firstRow ??= n;
            }
          });
          if (s.error) {
            unread.push(`${f.path}: ${s.error.slice(0, 100)}`);
            continue;
          }
          if (!matches) continue;
          Object.assign(hit, { rowsMatching: matches, inColumns: per, firstRow, example });
          if (s.stopped) hit.partial = `only the first ${Math.min(s.rows, 200_000)} rows were read`;
        }
        hits.push(hit);
      }
      const out = { dir: root, searched, files: hits.slice(0, 40) };
      if (hits.length > 40) out.leftOut = hits.length - 40;
      if (unread.length) out.unread = unread.slice(0, 10);
      if (skipped || found.length > 400) out.note = `${skipped + Math.max(0, found.length - 400)} files were not searched (40 s or 400 files reached); give a deeper folder`;
      else if (cut) out.note = "the walk stopped at 6 levels or 20000 entries; give a deeper folder to see more";
      return out;
    },

    /**
     * Run one SQL statement in duckdb (in-memory, working folder as its folder): sql("select rank, count(*) from 'roster.csv' group by 1").
     * Only statements that read, unless the caller asked for a change. At most o.max rows (default 200) come back. Not verified against a live server.
     */
    async sql(query, o = {}) {
      const q = String(query ?? "").trim().replace(/;\s*$/, "");
      if (!q) throw new Error("sql needs a query");
      if (/\bgetenv\s*\(|\bduckdb_secrets\b|\bcreate\s+(or\s+replace\s+)?(persistent\s+)?secret\b/i.test(q)) deny("that reads the environment or stored secrets, and answers go to a cloud model");
      for (const m of q.matchAll(/'((?:[^']|'')*)'/g)) if (SECRET_FILE.test(m[1])) deny(`${m[1]} looks like a file of credentials, and what is read here goes to a cloud model`);
      if (!act) {
        const bare = q.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, "x").replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
        if (bare.includes(";")) throw new Error("not in this ask: several SQL statements at once changes things, and the caller did not ask for a change (act: true)");
        if (!/^\s*(select|with|from|describe|summarize|show|explain|values|table)\b/i.test(bare) || /\b(copy|insert|update|delete|create|drop|alter|attach|install|load|export|import|call|pragma|set)\b/i.test(bare.replace(/^\s*\w+/, "")))
          throw new Error("not in this ask: a SQL statement that writes (COPY ... TO, CREATE, INSERT, ATTACH, INSTALL and the like) changes things, and the caller did not ask for a change (act: true)");
      }
      if (!duckdb) return { error: NO_DUCKDB };
      const max = Math.max(1, Math.min(Number(o.max ?? 200), 2000));
      const rows = [];
      let total = 0;
      const r = await duckRows(q, (row) => {
        total++;
        if (rows.length < max) {
          const obj = {};
          for (const k in row) obj[k] = isSecretName(k) && row[k] != null && row[k] !== "" ? REDACTED : show(row[k]);
          rows.push(obj);
        }
        return total < max + 100_000;
      }, { timeoutMs: o.timeoutMs ?? 60_000 });
      if (r.error) return { error: r.error };
      return { columns: rows.length ? Object.keys(rows[0]) : [], rows, total: r.stopped ? `over ${total - 1}` : total, complete: total <= max };
    },

    /** Writes a file. Only in an ask that asked for a change; see below. */
    async write() {
      throw new Error("not in this ask: data.write changes things, and the caller did not ask for a change (act: true)");
    },
  };

  if (act) {
    const cellOut = (v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
    const csvCell = (d) => {
      const needs = new RegExp(`["\\r\\n${d === "\t" ? "\\t" : d === "|" ? "\\|" : d}]|^\\s|\\s$`);
      return (v) => {
        const s = cellOut(v);
        return needs.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
    };
    /**
     * Write rows to a file: write("out.csv", rows) for an array of objects, or write("out.jsonl", {from: "in.csv", where, select, limit})
     * for a filtered or converted copy, streamed from file to file. The format comes from the name (csv, tsv, jsonl, json, and .gz of these) or o.format.
     * An existing file is replaced only with o.overwrite: true; that includes the file being read.
     */
    data.write = async (file, source, o = {}) => {
      if (file == null || file === "") throw new Error("write needs a file to write to");
      const abs = absOf(file);
      if (SECRET_FILE.test(abs)) deny(`${file} looks like a file of credentials; write somewhere else`);
      const f = formatOf(abs);
      const format = String(o.format ?? f.format ?? "").toLowerCase().replace("ndjson", "jsonl");
      if (!["csv", "tsv", "jsonl", "json"].includes(format)) throw new Error(`write needs a format it can write: csv, tsv, jsonl or json (from the file name, or format). ${f.format ? `${f.format} is read only.` : "Parquet and Excel are not written."}`);
      const from = source && !Array.isArray(source) && typeof source === "object" ? source : null;
      if (!from && !Array.isArray(source)) throw new Error("write(file, rows) needs an array of row objects, or {from: file, where, select, limit} for a copy");
      const P = from ? await prepare(from.from ?? from.file, from) : null;
      if (P?.error) return P;
      const exists = fs.existsSync(abs);
      if (exists && fs.statSync(abs).isDirectory()) return { file: rel(abs), error: "that is a folder" };
      if (exists && o.overwrite !== true && o.overwrite !== "true") {
        return { file: rel(abs), written: false, error: P && P.abs === abs ? `${rel(abs)} is the file being read; writing would replace it. Give another name, or pass overwrite: true if replacing it is what was asked.` : `${rel(abs)} exists already. Give another name, or pass overwrite: true if replacing it is what was asked.` };
      }
      const how = [];
      const delim = format === "tsv" ? "\t" : delimOf(o.delimiter) ?? ",";
      const q = csvCell(delim);
      const tmp = `${abs}.tmp-${process.pid}`;
      const started = Date.now();
      let n = 0;
      let columns = null;
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const sink = fs.createWriteStream(tmp);
        const outStream = f.gz ? zlib.createGzip() : sink;
        if (f.gz) outStream.pipe(sink);
        const closed = new Promise((res, rej) => (sink.on("finish", res), sink.on("error", rej), outStream.on("error", rej)));
        let buf = [];
        let size = 0;
        let waiting = null;
        const flush = () => {
          if (!buf.length) return;
          if (!outStream.write(buf.join("")) && !waiting) waiting = new Promise((res) => outStream.once("drain", () => ((waiting = null), res())));
          buf = [];
          size = 0;
        };
        const put = (s) => {
          buf.push(s);
          if ((size += s.length) > 1 << 16) flush();
        };
        const line = (obj, cols) => {
          if (format === "jsonl") put(`${JSON.stringify(obj)}\n`);
          else if (format === "json") put(`${n ? ",\n" : "[\n"}${JSON.stringify(obj)}`);
          else put(`${cols.map((c) => q(obj[c])).join(delim)}\n`);
          n++;
        };
        if (!from) {
          const rows = source.map((r) => (r && typeof r === "object" && !Array.isArray(r) ? r : { value: r }));
          columns = list(o.columns).length ? list(o.columns) : [...new Set(rows.flatMap((r) => Object.keys(r)))];
          if (format === "csv" || format === "tsv") put(`${columns.map(q).join(delim)}\n`);
          for (const r of rows) {
            line(r, columns);
            if (waiting) await waiting;
          }
        } else {
          const misses = {};
          const test = compileWhere(P, from.where, how, misses);
          const select = list(from.select).map((c) => column(P, c, how));
          const limit = from.limit != null ? Number(from.limit) : Infinity;
          const typed = P.delimiter && (format === "jsonl" || format === "json") ? o.typed === true || o.typed === "true" : null;
          const native = (obj) => {
            for (const k in obj) {
              const v = obj[k];
              const x = num(v);
              if (!Number.isNaN(x)) obj[k] = x;
              else if (v === "true" || v === "false") obj[k] = v === "true";
              else if (v === "") obj[k] = null;
            }
            return obj;
          };
          if (typed === false) how.push("cells of a delimited file are written as text, as they are in the source; pass typed: true to write numbers, true, false and empty cells as JSON values");
          const delimitedOut = format === "csv" || format === "tsv";
          columns = select.length ? select : P.columns;
          if (delimitedOut && !select.length && P.open) {
            // A JSON source may bring new keys late; a CSV needs all its columns first.
            const all = new Set(P.columns);
            await scan(P, { raw: true }, (row) => {
              for (const k in row) all.add(k);
            });
            columns = [...all];
          }
          if (delimitedOut) put(`${columns.map(q).join(delim)}\n`);
          const s = await scan(P, { raw: true, between: () => waiting, timeoutMs: 600_000 }, (row, _n, original) => {
            if (test && !test(row)) return;
            if (n >= limit) return false;
            // A JSON record goes to a JSON file as it was, nesting included, unless columns were picked.
            const obj = !delimitedOut && !select.length && original !== undefined ? original : toObject(P, columns, row);
            line(typed ? native(obj) : obj, columns);
          });
          if (s.error) throw new Error(s.error);
          how.push(...s.notes);
          missNotes(misses, how);
          const red = columns.filter(isSecretName);
          if (red.length) how.push(`${red.join(", ")} ${red.length === 1 ? "was" : "were"} copied as in the source; ${red.length === 1 ? "its values were" : "their values were"} not shown to anyone`);
        }
        if (format === "json") put(n ? "\n]\n" : "[]\n");
        flush();
        outStream.end();
        await closed;
        fs.renameSync(tmp, abs);
      } catch (e) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {}
        push({ kind: "data.write", detail: rel(abs), ms: Date.now() - started, code: 1 });
        return { file: rel(abs), written: false, error: `could not write: ${e.message}` };
      }
      const bytes = fs.statSync(abs).size;
      push({ kind: "data.write", detail: rel(abs), ms: Date.now() - started, code: 0, size: bytes });
      const out = { file: rel(abs), written: true, format: f.gz ? `${format}.gz` : format, rows: n, columns: columns.slice(0, 60), bytes, size: human(bytes), replaced: exists };
      if (P) out.from = P.file;
      if (how.length) out.notes = how;
      return out;
    };
  }

  return data;
}

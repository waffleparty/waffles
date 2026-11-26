// The parts of Python's behavior that the ported scripts keep, so that their output and their files stay byte for byte
// what the Python scripts wrote: json.loads and json.dumps, repr and str, the text of an OSError, strict UTF-8 reading
// with universal newlines, and the os.path functions whose results reach the output.
//
// A JSON value keeps the Python types it decodes to: an int is a bigint (exact at any size), a float is a number, and
// an object is a Map, which keeps its keys in their order, also keys that look like integers.

import { constants, platform } from 'node:os'
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export type PyValue = null | boolean | bigint | number | string | PyValue[] | PyDict
export type PyDict = Map<string, PyValue>

// str.isspace() in Python: JS's \s lacks \x1c-\x1f and \x85, and adds \ufeff.
const WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const STRIP = new RegExp(`^[${WS}]+|[${WS}]+$`, 'g')
export const NOT_SPACE = `[^${WS}]`

/** str.strip(): Python's whitespace by default, else the given characters. */
export function strip(text: string, chars?: string): string {
  if (chars === undefined) return text.replace(STRIP, '')
  const set = new Set(chars)
  const points = Array.from(text)
  let start = 0
  let end = points.length
  while (start < end && set.has(points[start]!)) start++
  while (end > start && set.has(points[end - 1]!)) end--
  return points.slice(start, end).join('')
}

/** str.splitlines(). */
export function splitlines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Sorts as Python sorts str: by code point, where JS compares UTF-16 code units. */
export function byCodePoint(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0)!)
  const y = Array.from(b, (c) => c.codePointAt(0)!)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return x.length - y.length
}

/** Universal newlines, as Python's text mode reads a file or a subprocess's output. */
export function universalNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

// --- Errors -------------------------------------------------------------------------------------------------------

/** A Python exception that the Python script lets end the run: the entry point prints its last traceback line. */
export class PyException extends Error {
  readonly type: string
  constructor(type: string, message: string) {
    super(message)
    this.type = type
  }
  override toString(): string {
    return `${this.type}: ${this.message}`
  }
}

export class ValueError extends PyException {
  constructor(message: string, type = 'ValueError') {
    super(type, message)
  }
}

// strerror() of the C library, which Python puts in an OSError. Linux words a few of them otherwise.
const STRERROR: Record<string, string> = {
  EPERM: 'Operation not permitted',
  ENOENT: 'No such file or directory',
  EIO: 'Input/output error',
  EBADF: 'Bad file descriptor',
  EAGAIN: 'Resource temporarily unavailable',
  EACCES: 'Permission denied',
  EBUSY: 'Resource busy',
  EEXIST: 'File exists',
  EXDEV: 'Cross-device link',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EINVAL: 'Invalid argument',
  ENFILE: 'Too many open files in system',
  EMFILE: 'Too many open files',
  ETXTBSY: 'Text file busy',
  EFBIG: 'File too large',
  ENOSPC: 'No space left on device',
  EROFS: 'Read-only file system',
  EMLINK: 'Too many links',
  ELOOP: 'Too many levels of symbolic links',
  ENAMETOOLONG: 'File name too long',
  ENOTEMPTY: 'Directory not empty',
  EDQUOT: 'Disc quota exceeded',
  ESRCH: 'No such process',
}
const LINUX_STRERROR: Record<string, string> = {
  EBUSY: 'Device or resource busy',
  EXDEV: 'Invalid cross-device link',
  EDQUOT: 'Disk quota exceeded',
}
// The OSError subclass Python raises for an errno, as its traceback names it.
const OS_ERROR_TYPE: Record<string, string> = {
  ENOENT: 'FileNotFoundError',
  EEXIST: 'FileExistsError',
  EACCES: 'PermissionError',
  EPERM: 'PermissionError',
  ENOTDIR: 'NotADirectoryError',
  EISDIR: 'IsADirectoryError',
}

type ErrnoError = Error & { code?: string; errno?: number; path?: string; dest?: string }

export function isErrno(error: unknown, ...codes: string[]): error is ErrnoError {
  return error instanceof Error && typeof (error as ErrnoError).code === 'string' && (codes.length === 0 || codes.includes((error as ErrnoError).code!))
}

/** str() of the OSError that Python raises where Node threw error: `[Errno 13] Permission denied: '/path'`. */
export function osErrorText(error: unknown, filename?: string): string {
  if (!isErrno(error)) return String(error)
  const code = error.code!
  const number = (constants.errno as Record<string, number>)[code] ?? Math.abs(error.errno ?? 0)
  const text = (platform() === 'linux' ? LINUX_STRERROR[code] : undefined) ?? STRERROR[code] ?? error.message
  const file = filename ?? error.path
  if (file === undefined) return `[Errno ${number}] ${text}`
  return `[Errno ${number}] ${text}: ${repr(file)}${error.dest !== undefined ? ` -> ${repr(error.dest)}` : ''}`
}

/** The OSError Python would raise for a Node error, to end the run with. */
export function osException(error: unknown, filename?: string): PyException {
  const code = isErrno(error) ? error.code! : ''
  return new PyException(OS_ERROR_TYPE[code] ?? 'OSError', osErrorText(error, filename))
}

// --- Text ---------------------------------------------------------------------------------------------------------

/** bytes.decode('utf-8') in strict mode, with the message of the UnicodeDecodeError it raises. */
export function decodeUtf8(bytes: Uint8Array): string {
  const fail = (start: number, end: number, reason: string): never => {
    const where = end - start === 1
      ? `byte 0x${bytes[start]!.toString(16).padStart(2, '0')} in position ${start}`
      : `bytes in position ${start}-${end - 1}`
    throw new ValueError(`'utf-8' codec can't decode ${where}: ${reason}`, 'UnicodeDecodeError')
  }
  const n = bytes.length
  for (let i = 0; i < n;) {
    const b = bytes[i]!
    if (b < 0x80) {
      i++
      continue
    }
    let need: number
    let lo = 0x80
    let hi = 0xbf
    if (b >= 0xc2 && b <= 0xdf) need = 1
    else if (b >= 0xe0 && b <= 0xef) {
      need = 2
      if (b === 0xe0) lo = 0xa0
      if (b === 0xed) hi = 0x9f
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3
      if (b === 0xf0) lo = 0x90
      if (b === 0xf4) hi = 0x8f
    } else return fail(i, i + 1, 'invalid start byte')
    for (let k = 1; k <= need; k++) {
      if (i + k >= n) return fail(i, n, 'unexpected end of data')
      const c = bytes[i + k]!
      const [min, max] = k === 1 ? [lo, hi] : [0x80, 0xbf]
      if (c < min || c > max) return fail(i, i + k, 'invalid continuation byte')
    }
    i += need + 1
  }
  // Python keeps a byte order mark as U+FEFF, which json.loads then refuses; TextDecoder drops it unless told not to.
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
}

/** open(path, encoding='utf-8').read(): strict UTF-8 and universal newlines. */
export function readText(path: string): string {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch (error) {
    // Reading a folder fails at read, which names no file in Node; Python's open names it.
    if (isErrno(error) && error.path === undefined) error.path = path
    throw error
  }
  return universalNewlines(decodeUtf8(bytes))
}

// --- repr and str -------------------------------------------------------------------------------------------------

// The characters str.isprintable() rejects, which repr() escapes. The space is printable.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u

function reprString(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'"
  let out = quote
  for (const c of text) {
    const point = c.codePointAt(0)!
    if (c === quote || c === '\\') out += `\\${c}`
    else if (c === '\t') out += '\\t'
    else if (c === '\n') out += '\\n'
    else if (c === '\r') out += '\\r'
    else if (c !== ' ' && (point < 0x20 || point === 0x7f || UNPRINTABLE.test(c))) {
      if (point < 0x100) out += `\\x${point.toString(16).padStart(2, '0')}`
      else if (point < 0x10000) out += `\\u${point.toString(16).padStart(4, '0')}`
      else out += `\\U${point.toString(16).padStart(8, '0')}`
    } else out += c
  }
  return out + quote
}

/** float.__repr__: the shortest digits that read back, fixed between 1e-4 and 1e16, else with an exponent. */
export function floatRepr(x: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf'
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0'
  const sign = x < 0 ? '-' : ''
  const [mantissa, exponent] = Math.abs(x).toExponential().split('e') as [string, string]
  const digits = mantissa.replace('.', '')
  const point = Number(exponent) + 1
  if (point > -4 && point <= 16) {
    if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`
    if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}.0`
    return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
  }
  const e = point - 1
  return `${sign}${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ''}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`
}

export function repr(value: PyValue): string {
  if (value === null) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return floatRepr(value)
  if (typeof value === 'string') return reprString(value)
  if (Array.isArray(value)) return `[${value.map(repr).join(', ')}]`
  return `{${[...value].map(([k, v]) => `${reprString(k)}: ${repr(v)}`).join(', ')}}`
}

/** str(value), as an f-string shows it. */
export function str(value: PyValue): string {
  return typeof value === 'string' ? value : repr(value)
}

/** Python's truth value. */
export function truthy(value: PyValue | undefined): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string' || Array.isArray(value)) return value.length > 0
  if (value instanceof Map) return value.size > 0
  if (typeof value === 'bigint') return value !== 0n
  if (typeof value === 'number') return value !== 0
  return value
}

/** isinstance(value, int), which a bool passes too. */
export function isInt(value: PyValue | undefined): value is bigint | boolean {
  return typeof value === 'bigint' || typeof value === 'boolean'
}

/** The int a bool or an int stands for: True + 1 is 2 in Python. */
export function asInt(value: bigint | boolean): bigint {
  return typeof value === 'boolean' ? (value ? 1n : 0n) : value
}

// The spaces int() skips: C's ASCII whitespace, and Unicode's other spaces, but not the separators \x1c-\x1f
// that str.strip takes.
const INT_WS = '\\t\\n\\v\\f\\r \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const INT_SPACE = new RegExp(`^[${INT_WS}]+|[${INT_WS}]+$`, 'g')

/** int(text) on a str: surrounding whitespace, a sign, underscores between digits, and any Unicode decimal digit. */
export function pyInt(text: string): bigint | null {
  const body = text.replace(INT_SPACE, '')
  if (!/^[+-]?\p{Nd}+(?:_\p{Nd}+)*$/u.test(body)) return null
  let n = 0n
  for (const c of body.replace(/[+_-]/g, '')) {
    let start = c.codePointAt(0)!
    const point = start
    // Unicode keeps every run of decimal digits contiguous, from 0 to 9.
    while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--
    n = n * 10n + BigInt((point - start) % 10)
  }
  return body.startsWith('-') ? -n : n
}

// --- json ---------------------------------------------------------------------------------------------------------

/** The message of a json.JSONDecodeError: the reason, with its line, column, and code point index. */
function decodeError(message: string, doc: string[], pos: number): ValueError {
  let line = 1
  let last = -1
  for (let i = 0; i < pos; i++) if (doc[i] === '\n') {
    line++
    last = i
  }
  return new ValueError(`${message}: line ${line} column ${pos - last} (char ${pos})`, 'JSONDecodeError')
}

class StopIteration {
  readonly value: number
  constructor(value: number) {
    this.value = value
  }
}

// CPython's C scanner (Modules/_json.c), which json.loads uses: the same values, and the same error at the same
// position. Positions count code points, as Python's str does.
class Scanner {
  readonly doc: string[]
  readonly end: number
  constructor(doc: string[]) {
    this.doc = doc
    this.end = doc.length - 1
  }

  ws(idx: number): number {
    while (idx <= this.end && ' \t\n\r'.includes(this.doc[idx]!)) idx++
    return idx
  }

  at(idx: number, word: string): boolean {
    return this.doc.slice(idx, idx + word.length).join('') === word
  }

  scan(idx: number): [PyValue, number] {
    const doc = this.doc
    if (idx > this.end) throw new StopIteration(idx)
    switch (doc[idx]) {
      case '"': return this.string(idx + 1)
      case '{': return this.object(idx + 1)
      case '[': return this.array(idx + 1)
      case 'n': if (this.at(idx, 'null')) return [null, idx + 4]
        break
      case 't': if (this.at(idx, 'true')) return [true, idx + 4]
        break
      case 'f': if (this.at(idx, 'false')) return [false, idx + 5]
        break
      case 'N': if (this.at(idx, 'NaN')) return [NaN, idx + 3]
        break
      case 'I': if (this.at(idx, 'Infinity')) return [Infinity, idx + 8]
        break
      case '-': if (this.at(idx, '-Infinity')) return [-Infinity, idx + 9]
        break
    }
    return this.number(idx)
  }

  number(start: number): [PyValue, number] {
    const doc = this.doc
    const digit = (i: number) => i <= this.end && doc[i]! >= '0' && doc[i]! <= '9'
    let idx = start
    if (doc[idx] === '-') {
      idx++
      if (idx > this.end) throw new StopIteration(start)
    }
    if (doc[idx]! >= '1' && doc[idx]! <= '9') {
      idx++
      while (digit(idx)) idx++
    } else if (doc[idx] === '0') idx++
    else throw new StopIteration(start)
    let isFloat = false
    if (idx < this.end && doc[idx] === '.' && digit(idx + 1)) {
      isFloat = true
      idx += 2
      while (digit(idx)) idx++
    }
    if (idx < this.end && (doc[idx] === 'e' || doc[idx] === 'E')) {
      const e = idx
      idx++
      if (idx < this.end && (doc[idx] === '-' || doc[idx] === '+')) idx++
      while (digit(idx)) idx++
      if (doc[idx - 1]! >= '0' && doc[idx - 1]! <= '9') isFloat = true
      else idx = e
    }
    const text = doc.slice(start, idx).join('')
    if (isFloat) return [Number(text), idx]
    const digits = text.replace('-', '').length
    // sys.int_info.default_max_str_digits: Python refuses longer int literals.
    if (digits > 4300) {
      throw new ValueError(`Exceeds the limit (4300 digits) for integer string conversion: value has ${digits} digits; use sys.set_int_max_str_digits() to increase the limit`)
    }
    return [BigInt(text), idx]
  }

  string(end: number): [string, number] {
    const doc = this.doc
    const len = doc.length
    const begin = end - 1
    let out = ''
    for (;;) {
      let next = end
      let c = ''
      for (; next < len; next++) {
        c = doc[next]!
        if (c === '"' || c === '\\') break
        if (c.codePointAt(0)! <= 0x1f) throw decodeError('Invalid control character at', doc, next)
      }
      if (next >= len || !(c === '"' || c === '\\')) throw decodeError('Unterminated string starting at', doc, begin)
      out += doc.slice(end, next).join('')
      next++
      if (c === '"') {
        end = next
        break
      }
      if (next === len) throw decodeError('Unterminated string starting at', doc, begin)
      c = doc[next]!
      if (c !== 'u') {
        end = next + 1
        const plain: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
        if (!(c in plain)) throw decodeError('Invalid \\escape', doc, end - 2)
        out += plain[c]
        continue
      }
      next++
      end = next + 4
      if (end >= len) throw decodeError('Invalid \\uXXXX escape', doc, next - 1)
      const hex = (from: number, at: number): number => {
        const text = doc.slice(from, from + 4).join('')
        if (!/^[0-9a-fA-F]{4}$/.test(text)) throw decodeError('Invalid \\uXXXX escape', doc, at)
        return Number.parseInt(text, 16)
      }
      let point = hex(next, end - 5)
      next = end
      if (point >= 0xd800 && point <= 0xdbff && end + 6 < len && doc[next] === '\\' && doc[next + 1] === 'u') {
        end += 6
        const low = hex(next + 2, end - 5)
        if (low >= 0xdc00 && low <= 0xdfff) point = 0x10000 + (((point - 0xd800) << 10) | (low - 0xdc00))
        else end -= 6
      }
      out += point >= 0x10000 ? String.fromCodePoint(point) : String.fromCharCode(point)
    }
    return [out, end]
  }

  object(idx: number): [PyDict, number] {
    const doc = this.doc
    const pairs: PyDict = new Map()
    idx = this.ws(idx)
    if (idx > this.end || doc[idx] !== '}') {
      while (idx <= this.end) {
        if (doc[idx] !== '"') throw decodeError('Expecting property name enclosed in double quotes', doc, idx)
        const [key, after] = this.string(idx + 1)
        idx = this.ws(after)
        if (idx > this.end || doc[idx] !== ':') throw decodeError("Expecting ':' delimiter", doc, idx)
        idx = this.ws(idx + 1)
        const [value, next] = this.scan(idx)
        pairs.set(key, value)
        idx = this.ws(next)
        if (idx <= this.end && doc[idx] === '}') break
        if (idx > this.end || doc[idx] !== ',') throw decodeError("Expecting ',' delimiter", doc, idx)
        idx = this.ws(idx + 1)
      }
      if (idx > this.end || doc[idx] !== '}') throw decodeError('Expecting property name enclosed in double quotes', doc, idx)
    }
    return [pairs, idx + 1]
  }

  array(idx: number): [PyValue[], number] {
    const doc = this.doc
    const items: PyValue[] = []
    idx = this.ws(idx)
    if (idx > this.end || doc[idx] !== ']') {
      for (;;) {
        const [value, next] = this.scan(idx)
        items.push(value)
        idx = this.ws(next)
        if (idx <= this.end && doc[idx] === ']') break
        if (idx > this.end || doc[idx] !== ',') throw decodeError("Expecting ',' delimiter", doc, idx)
        idx = this.ws(idx + 1)
      }
    }
    return [items, idx + 1]
  }
}

/** json.loads(text). Throws a ValueError with Python's message. */
export function loads(text: string): PyValue {
  const doc = Array.from(text)
  if (doc[0] === '\ufeff') throw decodeError('Unexpected UTF-8 BOM (decode using utf-8-sig)', doc, 0)
  const scanner = new Scanner(doc)
  let value: PyValue
  let end: number
  try {
    ;[value, end] = scanner.scan(scanner.ws(0))
  } catch (error) {
    if (error instanceof StopIteration) throw decodeError('Expecting value', doc, error.value)
    throw error
  }
  end = scanner.ws(end)
  if (end !== doc.length) throw decodeError('Extra data', doc, end)
  return value
}

/** A str as json.dumps writes it: ensure_ascii, so every character outside space to ~ is escaped. */
function encodeString(text: string): string {
  return JSON.stringify(text).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function encodeFloat(x: number): string {
  if (Number.isNaN(x)) return 'NaN'
  if (!Number.isFinite(x)) return x > 0 ? 'Infinity' : '-Infinity'
  return floatRepr(x)
}

/**
 * json.dumps(value) and json.dumps(value, indent=n): `, ` and `: ` on 1 line, or 1 item per line with `,` and `: `.
 */
export function dumps(value: PyValue, indent?: number): string {
  const encode = (v: PyValue, level: number): string => {
    if (v === null) return 'null'
    if (typeof v === 'boolean') return v ? 'true' : 'false'
    if (typeof v === 'bigint') return v.toString()
    if (typeof v === 'number') return encodeFloat(v)
    if (typeof v === 'string') return encodeString(v)
    const items = Array.isArray(v)
      ? v.map((item) => encode(item, level + 1))
      : [...v].map(([k, item]) => `${encodeString(k)}: ${encode(item, level + 1)}`)
    const [open, close] = Array.isArray(v) ? ['[', ']'] : ['{', '}']
    if (items.length === 0) return open + close
    if (indent === undefined) return open + items.join(', ') + close
    const inner = `\n${' '.repeat(indent * (level + 1))}`
    return open + inner + items.join(`,${inner}`) + `\n${' '.repeat(indent * level)}` + close
  }
  return encode(value, 0)
}

// --- os.path ------------------------------------------------------------------------------------------------------

const WINDOWS = platform() === 'win32'

/** os.path.join: a later absolute part starts the path again, and nothing is normalized. */
export function join(first: string, ...rest: string[]): string {
  if (WINDOWS) return resolve(first, ...rest)
  let path = first
  for (const part of rest) {
    if (part.startsWith('/')) path = part
    else if (!path || path.endsWith('/')) path += part
    else path += `/${part}`
  }
  return path
}

/** os.path.split. */
export function split(path: string): [string, string] {
  const i = path.lastIndexOf('/') + 1
  let head = path.slice(0, i)
  const tail = path.slice(i)
  if (head && head !== '/'.repeat(head.length)) head = head.replace(/\/+$/, '')
  return [head, tail]
}

export function dirname(path: string): string {
  return split(path)[0]
}

export function basename(path: string): string {
  return split(path)[1]
}

/** os.path.abspath. */
export function abspath(path: string): string {
  return resolve(path)
}

/** os.path.expanduser for `~` and `~/…`; another user's `~name` stays as it is. */
export function expanduser(path: string): string {
  if (path !== '~' && !path.startsWith('~/')) return path
  const home = process.env['HOME'] ?? process.env['USERPROFILE']
  if (home === undefined) return path
  return home.replace(/\/+$/, '') + path.slice(1) || '/'
}

/**
 * os.path.realpath without strict: each part's symlink is resolved in turn, `..` goes up from what that resolved to,
 * and the parts that do not exist are kept as they are.
 */
export function realpath(path: string): string {
  if (WINDOWS) {
    try {
      return realpathSync.native(path)
    } catch {
      return resolve(path)
    }
  }
  let current = isAbsolute(path) ? '/' : process.cwd()
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      current = dirname(current) || '/'
      continue
    }
    const next = join(current, part)
    try {
      current = lstatSync(next).isSymbolicLink() ? realpathSync(next) : next
    } catch {
      current = next
    }
  }
  return current
}

/** os.path.exists: false also for a symlink whose target is gone. */
export function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

export function isdir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function isfile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** os.path.commonpath of 2 absolute paths. */
export function commonpath(a: string, b: string): string {
  const parts = (p: string) => p.split(WINDOWS ? /[\\/]/ : '/').filter((c) => c && c !== '.')
  const x = parts(a)
  const y = parts(b)
  let i = 0
  while (i < x.length && i < y.length && x[i] === y[i]) i++
  return (WINDOWS ? '' : '/') + x.slice(0, i).join(WINDOWS ? '\\' : '/')
}

/** os.makedirs(path, exist_ok=True), with the error of the folder it failed on. */
export function makedirs(path: string): void {
  let [head, tail] = split(path)
  if (!tail) [head, tail] = split(head)
  if (head && tail && !exists(head)) {
    try {
      makedirs(head)
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error
    }
    if (tail === '.') return
  }
  try {
    mkdirSync(path)
  } catch (error) {
    if (!isdir(path)) throw error
  }
}

/**
 * A unit can present its identity in three encodings, and the store may scan any of
 * them. Only one needs reducing:
 *
 *   1. retail label 2D   R1205058450/20260722   -> serial 1205058450 + pack date
 *   2. the serial alone  1205058450             -> unchanged
 *   3. the ERP GS1-128   (01) 9009… (21) 1000…  -> unchanged, matched via `barcode`
 *
 * Getting this wrong is silent: a scan reduced badly matches nothing, the unit in the
 * counter's hand is filed as an unknown serial, and the real one is reported missing.
 * The over-eager direction is worse than the under-eager one, so most of these cases
 * check that a string is left ALONE.
 *
 * Run: npm run build && node api/test/scan-normalization.js
 */
const path = require('path');

const API = path.resolve(__dirname, '..');
const { normalizeScan, normalizeScannedSerial } = require(
  path.join(API, 'dist/db/scan-match.js'),
);

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass++;
    console.log('  ✓', name);
  } else {
    fail++;
    console.log('  ✗', name, detail ? `\n      ${detail}` : '');
  }
};

const reduces = (raw, serial, packDate) => {
  const got = normalizeScan(raw);
  check(
    `${raw} -> ${serial}`,
    got.serial === serial && got.packDate === packDate && got.wasComposite === true,
    `got serial=${got.serial} packDate=${got.packDate} composite=${got.wasComposite}`,
  );
};

const untouched = (raw, why) => {
  const got = normalizeScan(raw);
  check(
    `left alone: ${raw.length > 46 ? raw.slice(0, 46) + '…' : raw}  (${why})`,
    got.serial === raw.trim() && got.packDate === null && got.wasComposite === false,
    `got serial=${got.serial} composite=${got.wasComposite}`,
  );
};

console.log('\nthe retail label 2D composite');
// The real example, read off a PFD chicken breast label.
reduces('R1205058450/20260722', '1205058450', '2026-07-22');
reduces('  R1205058450/20260722  ', '1205058450', '2026-07-22');
// Any single-letter prefix, and serials of other lengths.
reduces('S9876/20250101', '9876', '2025-01-01');
reduces('R12345678901234567890/20991231', '12345678901234567890', '2099-12-31');

console.log('\nthe serial on its own');
untouched('1205058450', 'already the serial');
untouched('100000000462', 'a serial from the ERP');
untouched('85230763058414', 'a bare 14-digit serial');

console.log('\nthe ERP GS1-128, matched on the barcode column instead');
untouched(
  '(01) 90097586111018 (3202) 000082 (13) 240911 (21) 100000000462',
  'parenthesised GS1',
);
untouched('019009758611101832020000821324091121100000000462', 'raw GS1');

console.log('\nnot the 2D format — must not be shortened to a guess');
untouched('R1205058450/20261332', 'month 13, so the tail is not a date');
untouched('R1205058450/20260732', 'day 32');
untouched('R1205058450/19990722', 'year outside 2000-2099');
untouched('R1205058450/2026072', 'only 7 digits after the slash');
untouched('R1205058450/202607221', '9 digits after the slash');
untouched('R1205058450', 'no date half at all');
untouched('1205058450/20260722', 'no letter prefix');
untouched('RR1205058450/20260722', 'two-letter prefix');
untouched('RABC123/20260722', 'serial is not digits');
untouched('LOT/2026', 'unrelated string containing a slash');
untouched('', 'empty');

console.log('\nthe serial-only helper agrees with the full one');
check(
  'normalizeScannedSerial reduces the composite',
  normalizeScannedSerial('R1205058450/20260722') === '1205058450',
);
check(
  'normalizeScannedSerial passes a bare serial through',
  normalizeScannedSerial('1205058450') === '1205058450',
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

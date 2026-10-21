// CSV files people open in spreadsheet apps.

/**
 * Cells a spreadsheet app would run as a formula ("CSV injection"): text starting with =, @, a tab or a return, or
 * with + or - when what follows isn't a number. For Papa.unparse's `escapeFormulae`, which puts an apostrophe in
 * front so the app shows them as text. Numbers and phone numbers ("-12.5", "+1 (555) 010-2000") stay as they are.
 */
export const CSV_FORMULA = /^(?:[=@\t\r]|[+-](?![\d\s().,/-]*$))/;

/** A cell from a CSV file, with the apostrophe an export put in front of a formula-like value taken off again. */
export function unescapeCsvFormula(value: string): string {
  return typeof value === "string" && /^'[=@\t\r+-]/.test(value) && CSV_FORMULA.test(value.slice(1)) ? value.slice(1) : value;
}

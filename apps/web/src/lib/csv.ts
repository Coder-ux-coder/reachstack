// CSV out of the app: values a spreadsheet would run as formulas are written as text (see CSV_FORMULA).
import Papa from "papaparse";
import { CSV_FORMULA } from "@reachstack/shared";

export function toCsv(data: unknown[] | { fields: string[]; data: unknown[] }, opts: Papa.UnparseConfig = {}): string {
  return Papa.unparse(data as never, { escapeFormulae: CSV_FORMULA, ...opts });
}

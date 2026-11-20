/**
 * RFC 4180 CSV with spreadsheet formula-injection protection: cells starting with
 * = + - @ (or tab/CR) are prefixed with an apostrophe so Excel/Sheets treat them as text.
 */
const BOM = '\uFEFF';

export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    let text = Array.isArray(value) ? value.join('|') : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  // BOM so Excel opens UTF-8 names (e.g. accented characters) correctly.
  return `${BOM}${[headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}

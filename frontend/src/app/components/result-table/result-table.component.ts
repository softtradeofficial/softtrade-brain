import { Component, Input } from '@angular/core';
// Type-only import: erased at build time, so the library still loads lazily.
import type { CellObject, Row } from 'write-excel-file/browser';

/** Cell types Excel understands, worked out per column from the data. */
type ColumnType = 'text' | 'number' | 'date';

@Component({
  selector: 'app-result-table',
  templateUrl: './result-table.component.html',
  styleUrls: ['./result-table.component.css'],
})
export class ResultTableComponent {
  @Input() columns: string[] = [];
  @Input() rows: Record<string, unknown>[] = [];
  @Input() rowCount = 0;
  @Input() truncated = false;
  @Input() elapsedMs = 0;

  exporting = false;

  trackByIndex(index: number): number {
    return index;
  }

  /** Single-cell, single-row results are already stated in the answer text. */
  get isScalar(): boolean {
    return this.rows.length === 1 && this.columns.length === 1;
  }

  format(value: unknown): string {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'number') return value.toLocaleString();
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';

    const text = String(value);
    // ISO timestamps come back from the API as 2024-05-11T00:00:00.000Z
    const isoMatch = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(text);
    if (isoMatch) {
      return isoMatch[2] === '00:00' ? isoMatch[1] : `${isoMatch[1]} ${isoMatch[2]}`;
    }
    return text;
  }

  downloadCsv(): void {
    const escape = (value: unknown): string => {
      const text = value === null || value === undefined ? '' : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const lines = [
      this.columns.map(escape).join(','),
      ...this.rows.map((row) => this.columns.map((column) => escape(row[column])).join(',')),
    ];

    this.save(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' }), 'csv');
  }

  /**
   * Writes a real .xlsx. Unlike the CSV, numbers and dates keep their type, so totals,
   * sorting and pivot tables work in Excel without re-typing the columns by hand.
   */
  async downloadExcel(): Promise<void> {
    if (this.exporting) return;
    this.exporting = true;

    try {
      // Loaded on demand so the library stays out of the initial bundle.
      const writeXlsxFile = (await import('write-excel-file/browser')).default;

      const types = this.columns.map((column) => this.columnType(column));

      const header: Row = this.columns.map((column) => ({
        value: column,
        fontWeight: 'bold' as const,
      }));

      const body: Row[] = this.rows.map((row) =>
        this.columns.map((column, index) => this.excelCell(row[column], types[index]))
      );

      // write-excel-file v4 returns { toBlob, toFile } rather than taking a fileName option.
      await writeXlsxFile([header, ...body], {
        columns: this.columns.map((column, index) => ({
          width: Math.min(Math.max(column.length + 4, types[index] === 'text' ? 18 : 14), 50),
        })),
      }).toFile(`softtrade-${this.timestamp()}.xlsx`);
    } catch (error) {
      console.error('[export] xlsx failed, falling back to CSV', error);
      this.downloadCsv();
    } finally {
      this.exporting = false;
    }
  }

  /** Picks one type per column from the values actually present. */
  private columnType(column: string): ColumnType {
    let numbers = 0;
    let dates = 0;
    let seen = 0;

    for (const row of this.rows) {
      const value = row[column];
      if (value === null || value === undefined || value === '') continue;
      seen++;
      if (typeof value === 'number') numbers++;
      else if (typeof value === 'string' && this.isoDate(value)) dates++;
    }

    if (!seen) return 'text';
    if (numbers === seen) return 'number';
    if (dates === seen) return 'date';
    return 'text';
  }

  private isoDate(value: string): RegExpExecArray | null {
    return /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
  }

  private excelCell(value: unknown, type: ColumnType): CellObject | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    if (type === 'number') {
      return { value: Number(value), type: Number };
    }

    if (type === 'date') {
      const parts = this.isoDate(String(value));
      if (parts) {
        // Must be UTC midnight: the xlsx writer converts the Date to a UTC-based serial
        // number, so a local-midnight Date lands on the previous day in any timezone
        // ahead of UTC (in IST it showed 29/07 for a 30/07 bill).
        const date = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])));
        return { value: date, type: Date, format: 'dd/mm/yyyy' };
      }
    }

    if (typeof value === 'boolean') {
      return { value: value ? 'Yes' : 'No', type: String };
    }

    return { value: String(value), type: String };
  }

  private timestamp(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}`
    );
  }

  private save(blob: Blob, extension: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `softtrade-${this.timestamp()}.${extension}`;
    link.click();
    URL.revokeObjectURL(url);
  }
}

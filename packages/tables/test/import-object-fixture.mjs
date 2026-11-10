import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

export async function importWorkbook(rows, edit = () => {}) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Tickets');
  rows.forEach(row => sheet.addRow(row));
  edit(book, sheet);
  return Buffer.from(await book.xlsx.writeBuffer());
}

export function importObjectFixture() {
  const objects = new Map();
  const bytes = {
    async putIfAbsent(key, value) {
      if (!objects.has(key)) objects.set(key, Buffer.from(value));
    },
    async read(key, maximumBytes) {
      const value = objects.get(key);
      assert.ok(value, 'Import object exists');
      assert.ok(value.length <= maximumBytes, 'Import object obeys the read bound');
      return Buffer.from(value);
    },
    async remove(key) {
      objects.delete(key);
    },
  };
  return { attachments: bytes, snapshots: bytes };
}

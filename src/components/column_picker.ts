import m from 'mithril';
import {store} from '../core/store';
import {Checkbox} from '../widgets/checkbox';
import {Dropdown} from '../widgets/dropdown';

// Dropdown of checkboxes for choosing which catalog columns are shown. File
// columns and (when a metadata DB is configured) metadata columns are grouped
// separately. The choice is persisted by the store.

export class ColumnPicker implements m.ClassComponent {
  view(): m.Children {
    const columns = store.availableColumns();
    if (columns.length === 0) return null;

    const fileColumns = columns.filter((c) => c.source === 'file');
    const metaColumns = columns.filter((c) => c.source === 'metadata');

    return m(
      Dropdown,
      {
        label: 'Columns',
        icon: 'columns',
        align: 'right',
        panelClass: 'tl-colpicker',
      },
      [
        m('.tl-colpicker__group', [
          m('.tl-colpicker__group-label', 'File'),
          fileColumns.map((col) =>
            m(Checkbox, {
              key: col.id,
              label: col.label,
              checked: store.columnIsVisible(col.id),
              onchange: () => store.toggleColumn(col.id),
            }),
          ),
        ]),
        metaColumns.length > 0
          ? m('.tl-colpicker__group', [
              m('.tl-colpicker__group-label', 'Metadata'),
              metaColumns.map((col) =>
                m(Checkbox, {
                  key: col.id,
                  label: col.label,
                  checked: store.columnIsVisible(col.id),
                  onchange: () => store.toggleColumn(col.id),
                }),
              ),
            ])
          : null,
      ],
    );
  }
}

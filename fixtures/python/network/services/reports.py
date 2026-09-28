import os
import pathlib

FOLDER = os.environ.get('EXPORT_DIR', 'exports')


def to_csv(rows):
    return ''.join(','.join(row) + '\n' for row in rows)


def export(rows):
    folder = pathlib.Path(FOLDER)
    with open(folder / 'relatorio.csv', 'w') as file:
        file.write(to_csv(rows))
    (folder / 'ultimo.txt').write_text(str(len(rows)))
    return {'rows': len(rows)}
